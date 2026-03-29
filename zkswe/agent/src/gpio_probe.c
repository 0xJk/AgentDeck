/*
 * GPIO Probe Tool for ULANZI D200H (SSD210)
 * Enumerates GPIO lines and scans button matrix via /dev/gpiochip0
 *
 * Usage:
 *   gpio-probe --enumerate           List all GPIO lines
 *   gpio-probe --scan                Matrix scan (press buttons during scan)
 *   gpio-probe --monitor <line>      Watch a single line for changes
 *   gpio-probe --brute               Brute-force: read all lines, press buttons
 */
#define _POSIX_C_SOURCE 200112L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/ioctl.h>
#include <time.h>
#include <stdint.h>

/* Linux kernel types for GPIO ioctl structs (musl doesn't define these) */
typedef uint32_t __u32;
typedef uint8_t  __u8;

/* Linux GPIO chardev v1 ioctl definitions (for old kernels without <linux/gpio.h>) */
#define GPIO_MAX_NAME_SIZE 32

struct gpiochip_info {
    char name[GPIO_MAX_NAME_SIZE];
    char label[GPIO_MAX_NAME_SIZE];
    __u32 lines;
};

#define GPIOLINE_FLAG_KERNEL       (1 << 0)
#define GPIOLINE_FLAG_IS_OUT       (1 << 1)
#define GPIOLINE_FLAG_ACTIVE_LOW   (1 << 2)
#define GPIOLINE_FLAG_OPEN_DRAIN   (1 << 3)
#define GPIOLINE_FLAG_OPEN_SOURCE  (1 << 4)
#define GPIOLINE_FLAG_BIAS_PULL_UP   (1 << 5)
#define GPIOLINE_FLAG_BIAS_PULL_DOWN (1 << 6)
#define GPIOLINE_FLAG_BIAS_DISABLE   (1 << 7)

struct gpioline_info {
    __u32 line_offset;
    __u32 flags;
    char name[GPIO_MAX_NAME_SIZE];
    char consumer[GPIO_MAX_NAME_SIZE];
};

#define GPIOHANDLE_REQUEST_INPUT        (1 << 0)
#define GPIOHANDLE_REQUEST_OUTPUT       (1 << 1)
#define GPIOHANDLE_REQUEST_ACTIVE_LOW   (1 << 2)
#define GPIOHANDLE_REQUEST_OPEN_DRAIN   (1 << 3)
#define GPIOHANDLE_REQUEST_OPEN_SOURCE  (1 << 4)
#define GPIOHANDLE_REQUEST_BIAS_PULL_UP   (1 << 5)
#define GPIOHANDLE_REQUEST_BIAS_PULL_DOWN (1 << 6)
#define GPIOHANDLE_REQUEST_BIAS_DISABLE   (1 << 7)

#define GPIOHANDLES_MAX 64

struct gpiohandle_request {
    __u32 lineoffsets[GPIOHANDLES_MAX];
    __u32 flags;
    __u8  default_values[GPIOHANDLES_MAX];
    char  consumer_label[GPIO_MAX_NAME_SIZE];
    __u32 lines;
    int   fd;
};

struct gpiohandle_data {
    __u8 values[GPIOHANDLES_MAX];
};

#define GPIO_GET_CHIPINFO_IOCTL     _IOR(0xB4, 0x01, struct gpiochip_info)
#define GPIO_GET_LINEINFO_IOCTL     _IOWR(0xB4, 0x02, struct gpioline_info)
#define GPIO_GET_LINEHANDLE_IOCTL   _IOWR(0xB4, 0x03, struct gpiohandle_request)
#define GPIOHANDLE_GET_LINE_VALUES_IOCTL _IOWR(0xB4, 0x08, struct gpiohandle_data)
#define GPIOHANDLE_SET_LINE_VALUES_IOCTL _IOWR(0xB4, 0x09, struct gpiohandle_data)

#define GPIO_CHIP "/dev/gpiochip0"

static int chip_fd = -1;
static struct gpiochip_info chip_info;

static int open_chip(void) {
    chip_fd = open(GPIO_CHIP, O_RDONLY);
    if (chip_fd < 0) {
        fprintf(stderr, "Cannot open %s: %s\n", GPIO_CHIP, strerror(errno));
        return -1;
    }
    if (ioctl(chip_fd, GPIO_GET_CHIPINFO_IOCTL, &chip_info) < 0) {
        fprintf(stderr, "GPIO_GET_CHIPINFO failed: %s\n", strerror(errno));
        close(chip_fd);
        return -1;
    }
    return 0;
}

static void msleep(int ms) {
    struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
    nanosleep(&ts, NULL);
}

/* === ENUMERATE === */
static void cmd_enumerate(void) {
    printf("GPIO Chip: %s (%s), %u lines\n\n", chip_info.name, chip_info.label, chip_info.lines);
    printf("%-4s %-6s %-8s %-20s %-20s %s\n", "Line", "Dir", "Value", "Name", "Consumer", "Flags");
    printf("---- ------ -------- -------------------- -------------------- -----\n");

    for (__u32 i = 0; i < chip_info.lines; i++) {
        struct gpioline_info info;
        memset(&info, 0, sizeof(info));
        info.line_offset = i;
        if (ioctl(chip_fd, GPIO_GET_LINEINFO_IOCTL, &info) < 0) {
            printf("%-4u ERROR: %s\n", i, strerror(errno));
            continue;
        }

        const char *dir = (info.flags & GPIOLINE_FLAG_IS_OUT) ? "OUT" : "IN";
        const char *name = info.name[0] ? info.name : "-";
        const char *consumer = info.consumer[0] ? info.consumer : "-";

        /* Try to read current value */
        struct gpiohandle_request req;
        memset(&req, 0, sizeof(req));
        req.lineoffsets[0] = i;
        req.flags = GPIOHANDLE_REQUEST_INPUT;
        strncpy(req.consumer_label, "probe", sizeof(req.consumer_label));
        req.lines = 1;

        char val_str[8] = "?";
        if (!(info.flags & GPIOLINE_FLAG_KERNEL)) {
            if (ioctl(chip_fd, GPIO_GET_LINEHANDLE_IOCTL, &req) == 0) {
                struct gpiohandle_data data;
                if (ioctl(req.fd, GPIOHANDLE_GET_LINE_VALUES_IOCTL, &data) == 0) {
                    snprintf(val_str, sizeof(val_str), "%d", data.values[0]);
                }
                close(req.fd);
            }
        }

        char flags[64] = "";
        if (info.flags & GPIOLINE_FLAG_KERNEL) strcat(flags, "K ");
        if (info.flags & GPIOLINE_FLAG_ACTIVE_LOW) strcat(flags, "AL ");
        if (info.flags & GPIOLINE_FLAG_OPEN_DRAIN) strcat(flags, "OD ");
        if (info.flags & GPIOLINE_FLAG_OPEN_SOURCE) strcat(flags, "OS ");
        if (info.flags & GPIOLINE_FLAG_BIAS_PULL_UP) strcat(flags, "PU ");
        if (info.flags & GPIOLINE_FLAG_BIAS_PULL_DOWN) strcat(flags, "PD ");

        printf("%-4u %-6s %-8s %-20s %-20s %s\n", i, dir, val_str, name, consumer, flags);
    }
}

/* === MONITOR === */
static void cmd_monitor(int line) {
    if (line < 0 || (__u32)line >= chip_info.lines) {
        fprintf(stderr, "Line %d out of range (0-%u)\n", line, chip_info.lines - 1);
        return;
    }

    struct gpiohandle_request req;
    memset(&req, 0, sizeof(req));
    req.lineoffsets[0] = line;
    req.flags = GPIOHANDLE_REQUEST_INPUT | GPIOHANDLE_REQUEST_BIAS_PULL_UP;
    strncpy(req.consumer_label, "probe-mon", sizeof(req.consumer_label));
    req.lines = 1;

    if (ioctl(chip_fd, GPIO_GET_LINEHANDLE_IOCTL, &req) < 0) {
        /* Retry without pull-up (kernel may not support bias flags) */
        req.flags = GPIOHANDLE_REQUEST_INPUT;
        if (ioctl(chip_fd, GPIO_GET_LINEHANDLE_IOCTL, &req) < 0) {
            fprintf(stderr, "Cannot request line %d: %s\n", line, strerror(errno));
            return;
        }
        printf("(pull-up not supported, using default bias)\n");
    }

    printf("Monitoring GPIO line %d (Ctrl+C to stop)...\n", line);
    int last = -1;
    while (1) {
        struct gpiohandle_data data;
        if (ioctl(req.fd, GPIOHANDLE_GET_LINE_VALUES_IOCTL, &data) < 0) break;
        if (data.values[0] != last) {
            last = data.values[0];
            printf("  line %d = %d\n", line, last);
        }
        msleep(10);
    }
    close(req.fd);
}

/* === BRUTE-FORCE SCAN === */
static void cmd_brute(void) {
    printf("Brute-force scan: reading ALL available input lines.\n");
    printf("Press buttons one at a time. Ctrl+C to stop.\n\n");

    /* Request all non-kernel lines as input */
    int line_map[GPIOHANDLES_MAX];
    int fds[256]; /* one handle per line (can't batch kernel-used ones) */
    int nfds = 0;
    __u8 prev[256];
    memset(prev, 0xFF, sizeof(prev)); /* sentinel */

    for (__u32 i = 0; i < chip_info.lines && nfds < 256; i++) {
        struct gpioline_info info;
        memset(&info, 0, sizeof(info));
        info.line_offset = i;
        if (ioctl(chip_fd, GPIO_GET_LINEINFO_IOCTL, &info) < 0) continue;
        if (info.flags & GPIOLINE_FLAG_KERNEL) continue; /* skip kernel-claimed */

        struct gpiohandle_request req;
        memset(&req, 0, sizeof(req));
        req.lineoffsets[0] = i;
        req.flags = GPIOHANDLE_REQUEST_INPUT;
        strncpy(req.consumer_label, "probe-brute", sizeof(req.consumer_label));
        req.lines = 1;

        if (ioctl(chip_fd, GPIO_GET_LINEHANDLE_IOCTL, &req) == 0) {
            fds[nfds] = req.fd;
            line_map[nfds] = i;
            nfds++;
        }
    }

    printf("Monitoring %d lines. Press buttons now...\n", nfds);

    while (1) {
        int any_change = 0;
        for (int i = 0; i < nfds; i++) {
            struct gpiohandle_data data;
            if (ioctl(fds[i], GPIOHANDLE_GET_LINE_VALUES_IOCTL, &data) < 0) continue;
            if (prev[i] != 0xFF && data.values[0] != prev[i]) {
                printf("  GPIO %d: %d -> %d\n", line_map[i], prev[i], data.values[0]);
                any_change = 1;
            }
            prev[i] = data.values[0];
        }
        if (any_change) printf("---\n");
        msleep(10);
    }

    for (int i = 0; i < nfds; i++) close(fds[i]);
}

/* === MATRIX SCAN === */
static void cmd_scan(void) {
    printf("Matrix scan mode.\n");
    printf("This will try each GPIO as output (drive LOW) and read others as input.\n");
    printf("Press and HOLD a button during the scan to identify its wiring.\n\n");

    /* Collect available (non-kernel) lines */
    int avail[256];
    int navail = 0;
    for (__u32 i = 0; i < chip_info.lines && navail < 256; i++) {
        struct gpioline_info info;
        memset(&info, 0, sizeof(info));
        info.line_offset = i;
        if (ioctl(chip_fd, GPIO_GET_LINEINFO_IOCTL, &info) < 0) continue;
        if (info.flags & GPIOLINE_FLAG_KERNEL) continue;
        avail[navail++] = i;
    }
    printf("Available lines: %d\n", navail);

    printf("\nHold a button and press ENTER to scan (or 'q' to quit):\n");

    while (1) {
        char c = getchar();
        if (c == 'q' || c == 'Q') break;

        printf("\nScanning...\n");
        /* For each available line as output... */
        for (int oi = 0; oi < navail; oi++) {
            /* Request output, drive LOW */
            struct gpiohandle_request out_req;
            memset(&out_req, 0, sizeof(out_req));
            out_req.lineoffsets[0] = avail[oi];
            out_req.flags = GPIOHANDLE_REQUEST_OUTPUT;
            out_req.default_values[0] = 0; /* LOW */
            strncpy(out_req.consumer_label, "probe-out", sizeof(out_req.consumer_label));
            out_req.lines = 1;

            if (ioctl(chip_fd, GPIO_GET_LINEHANDLE_IOCTL, &out_req) < 0) continue;

            msleep(1); /* let it settle */

            /* Read all other lines as input */
            for (int ii = 0; ii < navail; ii++) {
                if (ii == oi) continue;
                struct gpiohandle_request in_req;
                memset(&in_req, 0, sizeof(in_req));
                in_req.lineoffsets[0] = avail[ii];
                in_req.flags = GPIOHANDLE_REQUEST_INPUT;
                strncpy(in_req.consumer_label, "probe-in", sizeof(in_req.consumer_label));
                in_req.lines = 1;

                if (ioctl(chip_fd, GPIO_GET_LINEHANDLE_IOCTL, &in_req) < 0) continue;

                struct gpiohandle_data data;
                if (ioctl(in_req.fd, GPIOHANDLE_GET_LINE_VALUES_IOCTL, &data) == 0) {
                    if (data.values[0] == 0) {
                        printf("  OUT=%d LOW -> IN=%d reads LOW  (CONNECTED!)\n", avail[oi], avail[ii]);
                    }
                }
                close(in_req.fd);
            }

            close(out_req.fd);
        }
        printf("Scan complete. Hold another button and press ENTER, or 'q' to quit.\n");
    }
}

int main(int argc, char **argv) {
    if (argc < 2) {
        printf("Usage: %s --enumerate|--scan|--brute|--monitor <line>\n", argv[0]);
        return 1;
    }

    if (open_chip() < 0) return 1;

    if (strcmp(argv[1], "--enumerate") == 0) {
        cmd_enumerate();
    } else if (strcmp(argv[1], "--scan") == 0) {
        cmd_scan();
    } else if (strcmp(argv[1], "--brute") == 0) {
        cmd_brute();
    } else if (strcmp(argv[1], "--monitor") == 0) {
        if (argc < 3) { fprintf(stderr, "Need line number\n"); close(chip_fd); return 1; }
        cmd_monitor(atoi(argv[2]));
    } else {
        fprintf(stderr, "Unknown command: %s\n", argv[1]);
        close(chip_fd);
        return 1;
    }

    close(chip_fd);
    return 0;
}
