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
#include <sys/stat.h>
#include <stdarg.h>

static volatile int running = 1;
static DashState state;
static int needs_render = 1;
static int buttons_available = 0;
static int use_stdin = 0; /* 1 = stdin mode, 0 = WS mode */
static const char *boot_log_path = "/data/agentdeck-boot.log";

static void boot_log(const char *fmt, ...) {
    FILE *f = fopen(boot_log_path, "a");
    if (!f) return;
    va_list ap;
    va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fputc('\n', f);
    fclose(f);
}

static void msleep(int ms) {
    struct timespec ts;
    ts.tv_sec = ms / 1000;
    ts.tv_nsec = (ms % 1000) * 1000000L;
    nanosleep(&ts, NULL);
}

static void on_signal(int sig) {
    boot_log("signal received: %d", sig);
    /* In immortal daemon mode, we ignore most signals to prevent being killed by watchdog.
     * We only exit if running becomes 0, which only happens via SIGKILL (not catchable) 
     * or if we explicitly catch SIGINT/SIGTERM in non-immortal mode. */
    if (sig == SIGINT || sig == SIGTERM) {
        boot_log("signal: stopping requested");
        running = 0;
    }
}

static void on_signal_immortal(int sig) {
    boot_log("signal received (IMMORTAL): %d - ignoring", sig);
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
        boot_log("send_command: stdout %s", json);
    } else {
        ws_send(json);
        boot_log("send_command: ws %s", json);
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
    fb_present();
    boot_log("render_disconnected: presented");
}

/* Lock USB sysfs to prevent ADB→HID mode switch.
 * Must run before anything else — once locked, ADB stays alive. */
static void lock_usb_sysfs(void) {
    const char *paths[] = {
        "/sys/class/zkswe_usb/zkswe0/functions",
        "/sys/class/zkswe_usb/zkswe0/enable",
    };
    for (int i = 0; i < 2; i++) {
        if (chmod(paths[i], 0444) == 0)
            printf("USB sysfs locked: %s\n", paths[i]);
    }
}

#include <pthread.h>
#include <termios.h>
#include <fcntl.h>
#include <errno.h>

static void *heartbeat_thread(void *arg) {
    (void)arg;
    boot_log("heartbeat_thread: starting (MCU spoofing)");
    
    int fd = open("/dev/ttyS0", O_RDWR | O_NOCTTY | O_NDELAY);
    if (fd < 0) {
        boot_log("heartbeat_thread: failed to open /dev/ttyS0: %s", strerror(errno));
        /* Try ttyS1 as fallback if ttyS0 fails */
        fd = open("/dev/ttyS1", O_RDWR | O_NOCTTY | O_NDELAY);
        if (fd < 0) return NULL;
    }

    /* Configure serial port: 115200 8N1 */
    struct termios options;
    tcgetattr(fd, &options);
    cfsetispeed(&options, B115200);
    cfsetospeed(&options, B115200);
    options.c_cflag |= (CLOCAL | CREAD);
    options.c_cflag &= ~PARENB;
    options.c_cflag &= ~CSTOPB;
    options.c_cflag &= ~CSIZE;
    options.c_cflag |= CS8;
    options.c_lflag &= ~(ICANON | ECHO | ECHOE | ISIG);
    options.c_iflag &= ~(IXON | IXOFF | IXANY);
    options.c_oflag &= ~OPOST;
    tcsetattr(fd, TCSANOW, &options);

    /* Heartbeat packet discovered via strace: 12 bytes starting with 55 AA */
    const unsigned char pkt[] = {0x55, 0xAA, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0xFB};

    while (1) {
        if (write(fd, pkt, sizeof(pkt)) != sizeof(pkt)) {
            boot_log("heartbeat_thread: write failed");
        }
        /* MCU expects heartbeat every ~500ms */
        msleep(500);
    }
    
    close(fd);
    return NULL;
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);
    printf("AgentDeck D200H Agent v1.2_heartbeat\n");
    boot_log("main: start v1.2_heartbeat argc=%d", argc);

    /* Detach from controlling terminal so we survive ADB shell disconnect. */
    setsid();
    signal(SIGHUP, SIG_IGN);
    signal(SIGPIPE, SIG_IGN);

    /* Start MCU heartbeat thread to keep hardware powered on while zkgui is frozen */
    pthread_t hb_tid;
    if (pthread_create(&hb_tid, NULL, heartbeat_thread, NULL) == 0) {
        pthread_detach(hb_tid);
        boot_log("main: heartbeat thread launched");
    }

    /* First thing: lock USB to keep ADB alive */
    lock_usb_sysfs();

    if (fb_init() < 0) {
        fprintf(stderr, "Failed to init framebuffer\n");
        boot_log("main: fb_init failed");
        return 1;
    }
    printf("Framebuffer OK (960x540)\n");
    boot_log("main: fb_init ok");

    dashboard_init();
    render_disconnected();
    printf("Initial render complete\n");
    boot_log("main: initial render complete");

    /* Init buttons — non-fatal if HID gadget unavailable */
    if (buttons_init() == 0) {
        buttons_available = 1;
        printf("Button input ready (HID gadget)\n");
        boot_log("main: buttons ready");
    } else {
        printf("Buttons unavailable (display-only mode)\n");
        boot_log("main: buttons unavailable");
    }

    int backoff_ms = WS_RECONNECT_MIN_MS;
    int backlight_counter = 0;
    int heartbeat_log_counter = 0;

    int use_daemon = (argc > 1 && strcmp(argv[1], "--daemon") == 0);
    use_stdin = (argc > 1 && strcmp(argv[1], "--stdin") == 0);
    boot_log("main: mode=%s", use_daemon ? "daemon" : (use_stdin ? "stdin" : "ws"));

    /* Immortal setup: ignore signals in daemon mode, catch for logging in others */
    if (use_daemon) {
        signal(SIGINT, on_signal_immortal);
        signal(SIGTERM, on_signal_immortal);
        signal(SIGHUP, on_signal_immortal);
    } else {
        signal(SIGINT, on_signal);
        signal(SIGTERM, on_signal);
        signal(SIGHUP, on_signal);
    }

    if (use_daemon) {
        /* ====== DAEMON MODE (IMMORTAL) ====== */
        printf("Running in DAEMON mode (IMMORTAL loop)\n");
        boot_log("daemon: loop start (forever)");
        while (1) {
            dashboard_render(&state);
            fb_present();

            if (buttons_available) buttons_process(on_button_press);

            backlight_counter++;
            if (backlight_counter >= (2000 / RENDER_MS)) {
                fb_set_backlight(255);
                backlight_counter = 0;
            }

            heartbeat_log_counter++;
            if (heartbeat_log_counter >= 100) {
                boot_log("heartbeat: daemon alive, running=%d", running);
                heartbeat_log_counter = 0;
            }

            msleep(RENDER_MS);
        }
    } else if (use_stdin) {
        printf("Running in stdin mode (reading JSON lines)\n");
        boot_log("stdin: loop start");
        char line[8192];
        int line_pos = 0;
        while (running) {
            fd_set fds;
            FD_ZERO(&fds);
            FD_SET(STDIN_FILENO, &fds);
            struct timeval tv = { 0, BUTTON_SCAN_MS * 1000 };
            int sel = select(STDIN_FILENO + 1, &fds, NULL, NULL, &tv);

            if (buttons_available) buttons_process(on_button_press);

            if (sel > 0 && FD_ISSET(STDIN_FILENO, &fds)) {
                int r = read(STDIN_FILENO, line + line_pos, sizeof(line) - line_pos - 1);
                if (r <= 0) {
                    boot_log("stdin: EOF, switching to immortal loop");
                    break;
                }
                line_pos += r;
                line[line_pos] = 0;

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
                int remaining = line_pos - (int)(start - line);
                if (remaining > 0) memmove(line, start, remaining);
                line_pos = remaining;
            }

            dashboard_render(&state);
            fb_present();
            needs_render = 0;

            backlight_counter++;
            if (backlight_counter >= (2000 / BUTTON_SCAN_MS)) {
                fb_set_backlight(255);
                backlight_counter = 0;
            }
        }
        /* stdin EOF or shutdown: fall through to immortal loop */
        boot_log("stdin: switching to immortal mode");
        while (1) {
            dashboard_render(&state);
            fb_present();
            if (buttons_available) buttons_process(on_button_press);
            backlight_counter++;
            if (backlight_counter >= (2000 / RENDER_MS)) {
                fb_set_backlight(255);
                backlight_counter = 0;
            }
            heartbeat_log_counter++;
            if (heartbeat_log_counter >= 100) {
                boot_log("heartbeat: stdin/immortal alive, running=%d", running);
                heartbeat_log_counter = 0;
            }
            msleep(RENDER_MS);
        }
    } else {
        /* WebSocket mode — also keeps rendering during backoff */
        boot_log("ws: loop start");
        while (running) {
            if (!ws_is_connected()) {
                printf("Connecting to daemon at %s:%d...\n", DAEMON_HOST, DAEMON_PORT);
                if (ws_connect(DAEMON_HOST, DAEMON_PORT) == 0) {
                    printf("Connected! Requesting state...\n");
                    boot_log("ws: connected");
                    ws_send("{\"type\":\"query_state\"}");
                    ws_send("{\"type\":\"query_usage\"}");
                    backoff_ms = WS_RECONNECT_MIN_MS;
                    needs_render = 1;
                } else {
                    int waited = 0;
                    while (waited < backoff_ms && running) {
                        dashboard_render(&state);
                        fb_present();
                        if (buttons_available) buttons_process(on_button_press);
                        msleep(RENDER_MS);
                        waited += RENDER_MS;
                    }
                    if (backoff_ms < WS_RECONNECT_MAX_MS)
                        backoff_ms *= 2;
                    continue;
                }
            }

            int result = ws_poll(on_ws_message, BUTTON_SCAN_MS);
            if (result < 0) {
                boot_log("ws: disconnected");
                render_disconnected();
                continue;
            }

            if (buttons_available) buttons_process(on_button_press);

            if (needs_render) {
                dashboard_render(&state);
                fb_present();
                needs_render = 0;
            }

            backlight_counter++;
            if (backlight_counter >= (2000 / BUTTON_SCAN_MS)) {
                fb_set_backlight(255);
                backlight_counter = 0;
            }
        }
        boot_log("ws: loop end (immortal fallback)");
        while(1) {
            dashboard_render(&state);
            fb_present();
            msleep(RENDER_MS);
        }
    }

    printf("Shutting down (NOT EXPECTED)...\n");
    if (buttons_available) buttons_close();
    ws_close();
    fb_close();
    boot_log("main: unexpected shutdown");
    return 0;
}
