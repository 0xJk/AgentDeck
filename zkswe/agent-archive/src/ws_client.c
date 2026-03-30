#define _POSIX_C_SOURCE 200112L
#include "ws_client.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <time.h>

static int sock_fd = -1;
static char recv_buf[65536];
static int recv_len = 0;

/* Base64 encode for WS key (minimal, 16 bytes in → 24 chars out) */
static const char b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void b64_encode(const unsigned char *in, int len, char *out) {
    int i, j = 0;
    for (i = 0; i < len; i += 3) {
        unsigned int v = (unsigned int)in[i] << 16;
        if (i+1 < len) v |= (unsigned int)in[i+1] << 8;
        if (i+2 < len) v |= in[i+2];
        out[j++] = b64[(v >> 18) & 63];
        out[j++] = b64[(v >> 12) & 63];
        out[j++] = (i+1 < len) ? b64[(v >> 6) & 63] : '=';
        out[j++] = (i+2 < len) ? b64[v & 63] : '=';
    }
    out[j] = 0;
}

int ws_connect(const char *host, int port) {
    ws_close();
    recv_len = 0;

    sock_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (sock_fd < 0) { perror("socket"); return -1; }

    /* TCP_NODELAY for low latency */
    int flag = 1;
    setsockopt(sock_fd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    inet_pton(AF_INET, host, &addr.sin_addr);

    if (connect(sock_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("connect");
        close(sock_fd); sock_fd = -1;
        return -1;
    }

    /* Generate random WS key */
    unsigned char key_raw[16];
    srand((unsigned)time(NULL) ^ getpid());
    for (int i = 0; i < 16; i++) key_raw[i] = rand() & 0xFF;
    char key_b64[32];
    b64_encode(key_raw, 16, key_b64);

    /* HTTP upgrade handshake */
    char req[512];
    int n = snprintf(req, sizeof(req),
        "GET / HTTP/1.1\r\n"
        "Host: %s:%d\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n",
        host, port, key_b64);

    if (write(sock_fd, req, n) != n) {
        perror("write handshake");
        close(sock_fd); sock_fd = -1;
        return -1;
    }

    /* Read response — expect "HTTP/1.1 101" */
    char resp[1024];
    int total = 0;
    while (total < (int)sizeof(resp) - 1) {
        struct timeval tv = { 5, 0 }; /* 5s timeout */
        fd_set fds; FD_ZERO(&fds); FD_SET(sock_fd, &fds);
        if (select(sock_fd + 1, &fds, NULL, NULL, &tv) <= 0) break;
        int r = read(sock_fd, resp + total, sizeof(resp) - 1 - total);
        if (r <= 0) break;
        total += r;
        resp[total] = 0;
        if (strstr(resp, "\r\n\r\n")) break;
    }

    if (!strstr(resp, "101")) {
        fprintf(stderr, "WS handshake failed: %.100s\n", resp);
        close(sock_fd); sock_fd = -1;
        return -1;
    }

    printf("WebSocket connected to %s:%d\n", host, port);
    return 0;
}

void ws_close(void) {
    if (sock_fd >= 0) close(sock_fd);
    sock_fd = -1;
    recv_len = 0;
}

int ws_is_connected(void) {
    return sock_fd >= 0;
}

/* Send a text frame (masked, as per RFC 6455 client requirement) */
int ws_send(const char *text) {
    if (sock_fd < 0) return -1;
    int len = (int)strlen(text);

    unsigned char header[14];
    int hlen = 0;
    header[0] = 0x81; /* FIN + text opcode */
    if (len < 126) {
        header[1] = 0x80 | len; /* MASK bit + len */
        hlen = 2;
    } else if (len < 65536) {
        header[1] = 0x80 | 126;
        header[2] = (len >> 8) & 0xFF;
        header[3] = len & 0xFF;
        hlen = 4;
    } else {
        return -1; /* too large */
    }

    /* Mask key */
    unsigned char mask[4];
    for (int i = 0; i < 4; i++) mask[i] = rand() & 0xFF;
    memcpy(header + hlen, mask, 4);
    hlen += 4;

    /* Masked payload */
    unsigned char *payload = (unsigned char *)malloc(len);
    for (int i = 0; i < len; i++) payload[i] = text[i] ^ mask[i & 3];

    int ok = (write(sock_fd, header, hlen) == hlen &&
              write(sock_fd, payload, len) == len) ? 0 : -1;
    free(payload);
    return ok;
}

/* Poll for incoming WS frames, call on_message for each text frame */
int ws_poll(ws_message_cb on_message, int timeout_ms) {
    if (sock_fd < 0) return -1;

    struct timeval tv = { timeout_ms / 1000, (timeout_ms % 1000) * 1000 };
    fd_set fds; FD_ZERO(&fds); FD_SET(sock_fd, &fds);
    int sel = select(sock_fd + 1, &fds, NULL, NULL, &tv);
    if (sel < 0) { ws_close(); return -1; }
    if (sel == 0) return 0; /* timeout, no data */

    int r = read(sock_fd, recv_buf + recv_len, sizeof(recv_buf) - recv_len - 1);
    if (r <= 0) { ws_close(); return -1; } /* disconnected */
    recv_len += r;

    /* Parse WS frames from buffer */
    while (recv_len >= 2) {
        unsigned char *buf = (unsigned char *)recv_buf;
        int opcode = buf[0] & 0x0F;
        int masked = (buf[1] >> 7) & 1;
        unsigned long long payload_len = buf[1] & 0x7F;
        int hdr_size = 2;

        if (payload_len == 126) {
            if (recv_len < 4) break;
            payload_len = ((unsigned)buf[2] << 8) | buf[3];
            hdr_size = 4;
        } else if (payload_len == 127) {
            if (recv_len < 10) break;
            payload_len = 0;
            for (int i = 0; i < 8; i++)
                payload_len = (payload_len << 8) | buf[2 + i];
            hdr_size = 10;
        }

        if (masked) hdr_size += 4;
        int frame_size = hdr_size + (int)payload_len;
        if (recv_len < frame_size) break;

        char *payload = recv_buf + hdr_size;
        if (masked) {
            unsigned char *mask = buf + hdr_size - 4;
            for (int i = 0; i < (int)payload_len; i++)
                payload[i] ^= mask[i & 3];
        }

        if (opcode == 0x1 && on_message) {
            /* Text frame */
            char saved = payload[payload_len];
            payload[payload_len] = 0;
            on_message(payload, (int)payload_len);
            payload[payload_len] = saved;
        } else if (opcode == 0x9) {
            /* Ping → send Pong */
            unsigned char pong[2] = { 0x8A, 0x80 }; /* FIN+pong, masked, 0 len */
            unsigned char pmask[4] = {0,0,0,0};
            write(sock_fd, pong, 2);
            write(sock_fd, pmask, 4);
        } else if (opcode == 0x8) {
            /* Close */
            ws_close();
            return -1;
        }

        /* Shift buffer */
        recv_len -= frame_size;
        if (recv_len > 0) memmove(recv_buf, recv_buf + frame_size, recv_len);
    }

    return 1;
}
