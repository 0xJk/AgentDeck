/*
 * AgentDeck D200H On-device Agent
 * Connects to daemon via WebSocket (adb reverse), renders dashboard to fb0
 */
#define _POSIX_C_SOURCE 200112L
#include "config.h"
#include "framebuffer.h"
#include "dashboard.h"
#include "ws_client.h"
#include "protocol.h"
#include "buttons.h"
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <signal.h>
#include <sys/select.h>

static volatile int running = 1;
static DashState state;
static int needs_render = 1;
static int buttons_available = 0;
static int use_stdin = 0; /* 1 = stdin mode, 0 = WS mode */

static void msleep(int ms) {
    struct timespec ts;
    ts.tv_sec = ms / 1000;
    ts.tv_nsec = (ms % 1000) * 1000000L;
    nanosleep(&ts, NULL);
}

static void on_signal(int sig) {
    (void)sig;
    running = 0;
}

static void on_ws_message(const char *data, int len) {
    if (protocol_parse(data, len, &state)) {
        needs_render = 1;
    }
}

static void send_command(const char *json) {
    if (use_stdin) {
        printf("%s\n", json);
        fflush(stdout);
    } else {
        ws_send(json);
    }
}

static void on_button_press(ButtonId id) {
    char cmd[256];
    switch (id) {
        case BTN_STOP:
            if (strcmp(state.state, "PROCESSING") == 0)
                send_command("{\"type\":\"interrupt\"}");
            else
                send_command("{\"type\":\"escape\"}");
            break;
        case BTN_QA1:
            send_command("{\"type\":\"select_option\",\"index\":0}");
            break;
        case BTN_QA2:
            send_command("{\"type\":\"select_option\",\"index\":1}");
            break;
        case BTN_QA3:
            send_command("{\"type\":\"select_option\",\"index\":2}");
            break;
        case BTN_QA4:
            send_command("{\"type\":\"select_option\",\"index\":3}");
            break;
        case BTN_MODE:
            /* Cycle: default → plan → default */
            if (strcmp(state.mode, "default") == 0)
                send_command("{\"type\":\"switch_mode\",\"mode\":\"plan\"}");
            else
                send_command("{\"type\":\"switch_mode\",\"mode\":\"default\"}");
            break;
        case BTN_SESSION:
            send_command("{\"type\":\"query_state\"}");
            break;
        case BTN_USAGE:
            send_command("{\"type\":\"query_usage\"}");
            break;
        default:
            /* MODEL, TOKENS, COST, 5H, 7D, INFO — display-only, no action */
            snprintf(cmd, sizeof(cmd), "{\"type\":\"button_info\",\"button\":%d}", (int)id);
            send_command(cmd);
            break;
    }
    /* Brief visual feedback — flash the key */
    needs_render = 1;
}

static void render_disconnected(void) {
    memset(&state, 0, sizeof(state));
    strcpy(state.state, "DISCONNECTED");
    strcpy(state.agentType, "claude-code");
    strcpy(state.mode, "---");
    strcpy(state.projectName, "---");
    strcpy(state.modelName, "---");
    dashboard_render(&state);
}

int main(int argc, char **argv) {
    printf("AgentDeck D200H Agent v1.0\n");

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    if (fb_init() < 0) {
        fprintf(stderr, "Failed to init framebuffer\n");
        return 1;
    }
    printf("Framebuffer OK (960x540)\n");

    dashboard_init();
    render_disconnected();
    printf("Initial render complete\n");

    /* Init buttons — non-fatal if HID gadget unavailable */
    if (buttons_init() == 0) {
        buttons_available = 1;
        printf("Button input ready (HID gadget)\n");
    } else {
        printf("Buttons unavailable (display-only mode)\n");
    }

    int backoff_ms = WS_RECONNECT_MIN_MS;
    int backlight_counter = 0;

    /* Try WS connection first (works if adb reverse is available).
     * If that fails, fall back to reading JSON lines from stdin
     * (daemon can pipe via: adb shell /data/agentdeck --stdin) */
    use_stdin = (argc > 1 && strcmp(argv[1], "--stdin") == 0);

    if (use_stdin) {
        printf("Running in stdin mode (reading JSON lines)\n");
        /* Use select() for non-blocking stdin + periodic GPIO button scan */
        char line[8192];
        int line_pos = 0;
        while (running) {
            fd_set fds;
            FD_ZERO(&fds);
            FD_SET(STDIN_FILENO, &fds);
            struct timeval tv = { 0, BUTTON_SCAN_MS * 1000 };
            int sel = select(STDIN_FILENO + 1, &fds, NULL, NULL, &tv);

            /* Scan buttons every cycle (GPIO polling, ~20ms) */
            if (buttons_available) buttons_process(on_button_press);

            if (sel > 0 && FD_ISSET(STDIN_FILENO, &fds)) {
                /* Read available bytes */
                int r = read(STDIN_FILENO, line + line_pos, sizeof(line) - line_pos - 1);
                if (r <= 0) break; /* EOF or error */
                line_pos += r;
                line[line_pos] = 0;

                /* Process complete lines */
                char *nl;
                char *start = line;
                while ((nl = strchr(start, '\n')) != NULL) {
                    *nl = 0;
                    int len = (int)(nl - start);
                    if (len > 0 && protocol_parse(start, len, &state)) {
                        needs_render = 1;
                    }
                    start = nl + 1;
                }
                /* Shift remaining partial line to front */
                int remaining = line_pos - (int)(start - line);
                if (remaining > 0) memmove(line, start, remaining);
                line_pos = remaining;
            }

            if (needs_render) {
                dashboard_render(&state);
                needs_render = 0;
            }

            /* Keep backlight */
            backlight_counter++;
            if (backlight_counter >= (2000 / BUTTON_SCAN_MS)) {
                fb_set_backlight(255);
                backlight_counter = 0;
            }
        }
    } else {
        /* WebSocket mode */
        while (running) {
            if (!ws_is_connected()) {
                printf("Connecting to daemon at %s:%d...\n", DAEMON_HOST, DAEMON_PORT);
                if (ws_connect(DAEMON_HOST, DAEMON_PORT) == 0) {
                    printf("Connected! Requesting state...\n");
                    ws_send("{\"type\":\"query_state\"}");
                    ws_send("{\"type\":\"query_usage\"}");
                    backoff_ms = WS_RECONNECT_MIN_MS;
                    needs_render = 1;
                } else {
                    printf("Connection failed, retry in %dms\n", backoff_ms);
                    msleep(backoff_ms);
                    if (backoff_ms < WS_RECONNECT_MAX_MS)
                        backoff_ms *= 2;
                    continue;
                }
            }

            int result = ws_poll(on_ws_message, BUTTON_SCAN_MS);
            if (result < 0) {
                printf("Disconnected from daemon\n");
                render_disconnected();
                continue;
            }

            if (buttons_available) buttons_process(on_button_press);

            if (needs_render) {
                dashboard_render(&state);
                needs_render = 0;
            }

            backlight_counter++;
            if (backlight_counter >= (2000 / BUTTON_SCAN_MS)) {
                fb_set_backlight(255);
                backlight_counter = 0;
            }
        }
    }

    printf("Shutting down...\n");
    if (buttons_available) buttons_close();
    ws_close();
    fb_close();
    return 0;
}
