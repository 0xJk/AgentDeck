#pragma once

/* Minimal WebSocket client over raw POSIX TCP */

typedef void (*ws_message_cb)(const char *data, int len);

int   ws_connect(const char *host, int port);
void  ws_close(void);
int   ws_is_connected(void);
int   ws_send(const char *text);
int   ws_poll(ws_message_cb on_message, int timeout_ms);
