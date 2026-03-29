/*
 * HID gadget sniffer for D200H button MCU
 * Reads raw HID reports from /dev/hidg1
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

static volatile int running = 1;
static void on_signal(int sig) { (void)sig; running = 0; }

static void print_hex_line(const unsigned char *buf, int len, int offset) {
    printf("[%04d] ", offset);
    for (int i = 0; i < len; i++) printf("%02X ", buf[i]);
    for (int i = len; i < 16; i++) printf("   ");
    printf(" |");
    for (int i = 0; i < len; i++) {
        unsigned char c = buf[i];
        printf("%c", (c >= 0x20 && c < 0x7F) ? c : '.');
    }
    printf("|\n");
}

int main(int argc, char **argv) {
    const char *device = argc > 1 ? argv[1] : "/dev/hidg1";

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    printf("HID sniff: %s\n", device);
    printf("Press buttons (Ctrl+C to stop)...\n\n");

    int fd = open(device, O_RDONLY);
    if (fd < 0) {
        fprintf(stderr, "Cannot open %s: %s\n", device, strerror(errno));
        return 1;
    }

    unsigned char buf[1024];
    int total = 0;
    int report_num = 0;
    struct timespec last_data;
    clock_gettime(CLOCK_MONOTONIC, &last_data);

    while (running) {
        int n = read(fd, buf, sizeof(buf));
        if (n > 0) {
            struct timespec now;
            clock_gettime(CLOCK_MONOTONIC, &now);
            long elapsed_ms = (now.tv_sec - last_data.tv_sec) * 1000 +
                              (now.tv_nsec - last_data.tv_nsec) / 1000000;
            last_data = now;

            printf("=== Report #%d (%d bytes, +%ldms) ===\n", report_num++, n, elapsed_ms);
            for (int off = 0; off < n; off += 16) {
                int chunk = n - off;
                if (chunk > 16) chunk = 16;
                print_hex_line(buf + off, chunk, off);
            }

            /* Try to interpret as key event */
            if (n >= 4) {
                /* Common HID key report: [modifier, reserved, key1, key2, ...] */
                printf("  → Possible key: modifier=0x%02X key=0x%02X 0x%02X 0x%02X\n",
                       buf[0], buf[1], buf[2], n > 3 ? buf[3] : 0);
            }

            total += n;
            fflush(stdout);
        } else if (n < 0 && errno != EAGAIN) {
            fprintf(stderr, "Read error: %s\n", strerror(errno));
            break;
        }
    }

    printf("\nTotal: %d bytes, %d reports\n", total, report_num);
    close(fd);
    return 0;
}
