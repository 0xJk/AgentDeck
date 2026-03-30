/*
 * UART sniffer/probe for D200H button MCU protocol
 * Opens /dev/ttyS1 at 115200 baud, sends query commands, prints responses
 * Usage: uart-sniff [device] [baud] [--query]
 */
#define _DEFAULT_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <termios.h>
#include <time.h>
#include <signal.h>

static volatile int running = 1;

static void on_signal(int sig) { (void)sig; running = 0; }

static speed_t baud_to_speed(int baud) {
    switch (baud) {
        case 9600:   return B9600;
        case 19200:  return B19200;
        case 38400:  return B38400;
        case 57600:  return B57600;
        case 115200: return B115200;
        default:     return B115200;
    }
}

static int serial_open(const char *device, int baud) {
    int fd = open(device, O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (fd < 0) {
        fprintf(stderr, "Cannot open %s: %s\n", device, strerror(errno));
        return -1;
    }

    struct termios tty;
    memset(&tty, 0, sizeof(tty));
    tcgetattr(fd, &tty);

    cfsetospeed(&tty, baud_to_speed(baud));
    cfsetispeed(&tty, baud_to_speed(baud));

    tty.c_cflag |= (CLOCAL | CREAD);
    tty.c_cflag &= ~PARENB;
    tty.c_cflag &= ~CSTOPB;
    tty.c_cflag &= ~CSIZE;
    tty.c_cflag |= CS8;
    tty.c_cflag &= ~CRTSCTS;
    tty.c_lflag &= ~(ICANON | ECHO | ECHOE | ISIG);
    tty.c_iflag &= ~(IXON | IXOFF | IXANY | IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL);
    tty.c_oflag &= ~OPOST;
    tty.c_cc[VMIN] = 0;
    tty.c_cc[VTIME] = 1;

    tcsetattr(fd, TCSANOW, &tty);
    tcflush(fd, TCIOFLUSH);
    return fd;
}

static void print_hex(const unsigned char *buf, int len, int offset) {
    printf("[%04d] ", offset);
    for (int i = 0; i < len; i++) {
        printf("%02X ", buf[i]);
    }
    /* pad if short */
    for (int i = len; i < 16; i++) printf("   ");
    printf(" |");
    for (int i = 0; i < len; i++) {
        unsigned char c = buf[i];
        printf("%c", (c >= 0x20 && c < 0x7F) ? c : '.');
    }
    printf("|\n");
}

static int read_response(int fd, int timeout_ms) {
    unsigned char buf[256];
    int total = 0;
    int idle_count = 0;
    int max_idle = timeout_ms / 10;

    while (idle_count < max_idle && total < (int)sizeof(buf)) {
        int n = read(fd, buf + total, sizeof(buf) - total);
        if (n > 0) {
            total += n;
            idle_count = 0;
        } else {
            idle_count++;
            usleep(10000);
        }
    }

    if (total > 0) {
        for (int off = 0; off < total; off += 16) {
            int chunk = total - off;
            if (chunk > 16) chunk = 16;
            print_hex(buf + off, chunk, off);
        }
    }
    return total;
}

/* Common ZKSWE/Stream Deck MCU protocol query patterns */
static void send_query(int fd, const unsigned char *data, int len, const char *label) {
    printf("\n--- Sending: %s (", label);
    for (int i = 0; i < len; i++) printf("%02X%s", data[i], i < len-1 ? " " : "");
    printf(") ---\n");

    tcflush(fd, TCIFLUSH);
    write(fd, data, len);
    usleep(50000); /* 50ms settle */
    int got = read_response(fd, 500);
    printf("  → %d bytes received\n", got);
}

int main(int argc, char **argv) {
    const char *device = "/dev/ttyS1";
    int baud = 115200;
    int query = 0;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--query") == 0) query = 1;
        else if (argv[i][0] == '/') device = argv[i];
        else if (argv[i][0] >= '0' && argv[i][0] <= '9') baud = atoi(argv[i]);
    }

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    printf("UART sniff: %s @ %d baud%s\n", device, baud, query ? " (with queries)" : "");

    int fd = serial_open(device, baud);
    if (fd < 0) return 1;

    if (query) {
        /* Try common MCU protocol queries */
        /* ZKSWE typically uses: header(55 AA or AA 55) + cmd + len + data + checksum */

        /* Pattern 1: 55 AA query key status */
        unsigned char q1[] = {0x55, 0xAA, 0x01, 0x00, 0x00, 0x01};
        send_query(fd, q1, sizeof(q1), "55 AA 01 query");

        /* Pattern 2: AA 55 query */
        unsigned char q2[] = {0xAA, 0x55, 0x01, 0x00, 0x00, 0x01};
        send_query(fd, q2, sizeof(q2), "AA 55 01 query");

        /* Pattern 3: STX based */
        unsigned char q3[] = {0x02, 0x01, 0x00, 0x03};
        send_query(fd, q3, sizeof(q3), "STX 01 ETX");

        /* Pattern 4: Stream Deck USB-like */
        unsigned char q4[] = {0x05, 0x00, 0x00, 0x00};
        send_query(fd, q4, sizeof(q4), "05 query");

        /* Pattern 5: single byte queries */
        for (int b = 0; b < 16; b++) {
            unsigned char q = (unsigned char)b;
            char label[16];
            snprintf(label, sizeof(label), "byte 0x%02X", b);
            send_query(fd, &q, 1, label);
        }

        /* Pattern 6: ZKSWE custom - try raw key query (from manifest/protocol analysis) */
        unsigned char q6[] = {0x5A, 0x4B, 0x01, 0x00}; /* 'Z' 'K' cmd len */
        send_query(fd, q6, sizeof(q6), "ZK 01 query");

        unsigned char q7[] = {0xA5, 0x5A, 0x01, 0x00};
        send_query(fd, q7, sizeof(q7), "A5 5A query");

        /* Pattern 7: D200 strmdck protocol header */
        unsigned char q8[] = {0x73, 0x74, 0x72, 0x6D, 0x64, 0x63, 0x6B}; /* "strmdck" */
        send_query(fd, q8, sizeof(q8), "strmdck header");

        printf("\n--- Query probing done ---\n");
    }

    printf("\nListening for data (press buttons, Ctrl+C to stop)...\n\n");

    int total = 0;
    int line_bytes = 0;
    unsigned char buf[256];
    unsigned char line_buf[16];
    struct timespec last_data;
    clock_gettime(CLOCK_MONOTONIC, &last_data);

    while (running) {
        int n = read(fd, buf, sizeof(buf));
        if (n > 0) {
            struct timespec now;
            clock_gettime(CLOCK_MONOTONIC, &now);
            long gap_ms = (now.tv_sec - last_data.tv_sec) * 1000 +
                          (now.tv_nsec - last_data.tv_nsec) / 1000000;
            last_data = now;

            if (gap_ms > 100 && line_bytes > 0) {
                print_hex(line_buf, line_bytes, total - line_bytes);
                line_bytes = 0;
            }

            for (int i = 0; i < n; i++) {
                line_buf[line_bytes++] = buf[i];
                if (line_bytes >= 16) {
                    print_hex(line_buf, 16, total + i - 15);
                    line_bytes = 0;
                }
            }
            total += n;
            fflush(stdout);
        }
        usleep(10000);
    }

    if (line_bytes > 0) print_hex(line_buf, line_bytes, total - line_bytes);
    printf("\nTotal: %d bytes\n", total);
    close(fd);
    return 0;
}
