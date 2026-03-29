/*
 * Sysfs GPIO probe for D200H button matrix
 * Uses the same sysfs approach as the original zkgui firmware:
 *   /sys/class/gpio/export → direction → value → edge
 *
 * Known pin candidates from zkgui (via gpiochip_info):
 *   Outputs: 4, 5, 6, 9, 85 (drove outputs, row scan)
 *   Input:   86 (read input)
 *
 * Modes:
 *   --setup    Export and configure all candidate pins
 *   --scan     Matrix scan: drive outputs LOW one at a time, read inputs
 *   --monitor  Watch all input pins for value changes
 *   --all      Full pin sweep: export 0-87, try to read each
 */
#define _DEFAULT_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <time.h>
#include <signal.h>

#define GPIO_BASE "/sys/class/gpio"
#define MAX_PINS 88

static volatile int running = 1;
static void on_signal(int sig) { (void)sig; running = 0; }

static int gpio_export(int pin) {
    char path[64];
    snprintf(path, sizeof(path), GPIO_BASE "/gpio%d", pin);
    if (access(path, F_OK) == 0) return 0; /* already exported */

    int fd = open(GPIO_BASE "/export", O_WRONLY);
    if (fd < 0) return -1;
    char buf[8];
    int len = snprintf(buf, sizeof(buf), "%d", pin);
    int ret = (write(fd, buf, len) == len) ? 0 : -1;
    close(fd);
    usleep(50000); /* wait for sysfs to create nodes */
    return ret;
}

static int gpio_unexport(int pin) {
    int fd = open(GPIO_BASE "/unexport", O_WRONLY);
    if (fd < 0) return -1;
    char buf[8];
    int len = snprintf(buf, sizeof(buf), "%d", pin);
    write(fd, buf, len);
    close(fd);
    return 0;
}

static int gpio_set_direction(int pin, const char *dir) {
    char path[64];
    snprintf(path, sizeof(path), GPIO_BASE "/gpio%d/direction", pin);
    int fd = open(path, O_WRONLY);
    if (fd < 0) return -1;
    write(fd, dir, strlen(dir));
    close(fd);
    return 0;
}

static int gpio_set_value(int pin, int val) {
    char path[64];
    snprintf(path, sizeof(path), GPIO_BASE "/gpio%d/value", pin);
    int fd = open(path, O_WRONLY);
    if (fd < 0) return -1;
    write(fd, val ? "1" : "0", 1);
    close(fd);
    return 0;
}

static int gpio_get_value(int pin) {
    char path[64];
    snprintf(path, sizeof(path), GPIO_BASE "/gpio%d/value", pin);
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -1;
    char buf[4] = {0};
    read(fd, buf, sizeof(buf));
    close(fd);
    return buf[0] - '0';
}

static int gpio_set_edge(int pin, const char *edge) {
    char path[64];
    snprintf(path, sizeof(path), GPIO_BASE "/gpio%d/edge", pin);
    int fd = open(path, O_WRONLY);
    if (fd < 0) return -1;
    write(fd, edge, strlen(edge));
    close(fd);
    return 0;
}

/* Known candidate output pins (rows) and input pin (columns) */
static int out_pins[] = {4, 5, 6, 9, 85};
static int out_count = 5;
static int in_pin = 86;

/* Extended candidate input pins: focus on HIGH-reading pins (have pull-ups) */
static int candidate_inputs[] = {0, 1, 84, 85, 86, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 72, 74, 75, 76, 77};
static int candidate_input_count = 20;

static void cmd_setup(void) {
    printf("Setting up GPIO pins via sysfs...\n");

    /* Export and configure output pins */
    for (int i = 0; i < out_count; i++) {
        if (gpio_export(out_pins[i]) == 0) {
            gpio_set_direction(out_pins[i], "out");
            gpio_set_value(out_pins[i], 1); /* HIGH (idle) */
            printf("  OUT pin %d: exported, direction=out, value=1\n", out_pins[i]);
        } else {
            printf("  OUT pin %d: FAILED to export (%s)\n", out_pins[i], strerror(errno));
        }
    }

    /* Export and configure input pins */
    for (int i = 0; i < candidate_input_count; i++) {
        int p = candidate_inputs[i];
        if (gpio_export(p) == 0) {
            gpio_set_direction(p, "in");
            int val = gpio_get_value(p);
            printf("  IN  pin %d: exported, direction=in, value=%d\n", p, val);
        } else {
            printf("  IN  pin %d: FAILED (%s)\n", p, strerror(errno));
        }
    }
}

static void cmd_scan(void) {
    printf("Matrix scan (drive each output LOW, read all inputs)...\n");
    printf("Hold a button while this runs.\n\n");

    /* First read baseline (all outputs HIGH) */
    printf("Baseline (all outputs HIGH):\n");
    for (int i = 0; i < candidate_input_count; i++) {
        int p = candidate_inputs[i];
        int v = gpio_get_value(p);
        if (v >= 0) printf("  IN %d = %d\n", p, v);
    }

    printf("\nScanning matrix...\n");
    for (int oi = 0; oi < out_count; oi++) {
        gpio_set_value(out_pins[oi], 0); /* drive LOW */
        usleep(1000); /* 1ms settle */

        printf("\n  OUT %d = LOW:\n", out_pins[oi]);
        for (int ii = 0; ii < candidate_input_count; ii++) {
            int p = candidate_inputs[ii];
            int v = gpio_get_value(p);
            if (v == 0) {
                printf("    → IN %d = LOW  *** CONNECTED ***\n", p);
            }
        }

        gpio_set_value(out_pins[oi], 1); /* restore HIGH */
        usleep(1000);
    }
}

static void cmd_monitor(void) {
    printf("Monitoring all input pins (press buttons, Ctrl+C to stop)...\n");

    int prev[MAX_PINS];
    memset(prev, -1, sizeof(prev));

    /* Read initial state */
    for (int i = 0; i < candidate_input_count; i++) {
        int p = candidate_inputs[i];
        prev[p] = gpio_get_value(p);
    }

    printf("Initial: ");
    for (int i = 0; i < candidate_input_count; i++) {
        int p = candidate_inputs[i];
        printf("%d=%d ", p, prev[p]);
    }
    printf("\n\n");

    while (running) {
        int changed = 0;
        for (int i = 0; i < candidate_input_count; i++) {
            int p = candidate_inputs[i];
            int v = gpio_get_value(p);
            if (v >= 0 && v != prev[p]) {
                printf("  GPIO %d: %d → %d\n", p, prev[p], v);
                prev[p] = v;
                changed = 1;
            }
        }
        if (changed) printf("---\n");
        usleep(10000); /* 10ms */
    }
}

static void cmd_all(void) {
    printf("Full pin sweep: export all pins 0-%d, read values...\n", MAX_PINS - 1);

    for (int p = 0; p < MAX_PINS; p++) {
        if (gpio_export(p) == 0) {
            /* Try reading direction */
            char path[64];
            snprintf(path, sizeof(path), GPIO_BASE "/gpio%d/direction", p);
            int fd = open(path, O_RDONLY);
            char dir[8] = "?";
            if (fd >= 0) {
                read(fd, dir, sizeof(dir) - 1);
                close(fd);
                /* trim newline */
                char *nl = strchr(dir, '\n');
                if (nl) *nl = 0;
            }

            int val = gpio_get_value(p);
            printf("  GPIO %2d: dir=%-4s val=%d\n", p, dir, val);

            /* Unexport to avoid interfering */
            gpio_unexport(p);
        } else {
            /* Skip silently — many pins can't be exported */
        }
    }
}

static void cmd_continuous_scan(void) {
    printf("Continuous matrix scan (every 20ms, Ctrl+C to stop)...\n");
    printf("Press buttons to see which output→input pairs activate.\n\n");

    int prev_map[5][20]; /* [out_idx][in_idx] */
    memset(prev_map, -1, sizeof(prev_map));

    while (running) {
        for (int oi = 0; oi < out_count; oi++) {
            gpio_set_value(out_pins[oi], 0);
            usleep(500);

            for (int ii = 0; ii < candidate_input_count; ii++) {
                int v = gpio_get_value(candidate_inputs[ii]);
                if (v != prev_map[oi][ii] && v == 0) {
                    printf("  PRESS: OUT=%d IN=%d\n", out_pins[oi], candidate_inputs[ii]);
                }
                if (v != prev_map[oi][ii] && v == 1 && prev_map[oi][ii] == 0) {
                    printf("  RELEASE: OUT=%d IN=%d\n", out_pins[oi], candidate_inputs[ii]);
                }
                prev_map[oi][ii] = v;
            }

            gpio_set_value(out_pins[oi], 1);
            usleep(500);
        }
        usleep(15000); /* ~20ms total cycle */
    }
}

static void cleanup(void) {
    /* Unexport all pins we might have exported */
    for (int i = 0; i < out_count; i++) gpio_unexport(out_pins[i]);
    for (int i = 0; i < candidate_input_count; i++) gpio_unexport(candidate_inputs[i]);
}

int main(int argc, char **argv) {
    if (argc < 2) {
        printf("Usage: %s --setup|--scan|--monitor|--all|--continuous\n", argv[0]);
        printf("  --setup       Export and configure candidate GPIO pins\n");
        printf("  --scan        One-shot matrix scan (hold button)\n");
        printf("  --monitor     Watch input pins for changes\n");
        printf("  --all         Full sweep: export all 0-87 pins\n");
        printf("  --continuous  Continuous matrix scan (best for discovery)\n");
        return 1;
    }

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    if (strcmp(argv[1], "--setup") == 0) {
        cmd_setup();
    } else if (strcmp(argv[1], "--scan") == 0) {
        cmd_setup();
        cmd_scan();
        cleanup();
    } else if (strcmp(argv[1], "--monitor") == 0) {
        cmd_setup();
        cmd_monitor();
        cleanup();
    } else if (strcmp(argv[1], "--all") == 0) {
        cmd_all();
    } else if (strcmp(argv[1], "--continuous") == 0) {
        cmd_setup();
        cmd_continuous_scan();
        cleanup();
    } else {
        fprintf(stderr, "Unknown command: %s\n", argv[1]);
        return 1;
    }

    return 0;
}
