#pragma once

#include <cstdint>

namespace Net {

/**
 * Initialize WebSocket client (does not connect yet).
 */
void wsInit();

/**
 * Connect to bridge WebSocket.
 * @param ip   Bridge IP address
 * @param port Bridge port
 * @param token Auth token (empty string for local)
 */
void wsConnect(const char* ip, uint16_t port, const char* token);

/**
 * Disconnect from bridge.
 */
void wsDisconnect();

/**
 * Process WebSocket events. Call from network task loop.
 */
void wsLoop();

/**
 * Check if WebSocket is connected.
 */
bool wsConnected();

/**
 * Send a JSON command to the bridge.
 * @param json Null-terminated JSON string
 */
void wsSend(const char* json);

/**
 * Send a typed command with no extra fields.
 */
void wsSendCommand(const char* type);

/**
 * Send respond command.
 */
void wsSendRespond(const char* value);

/**
 * Send select_option command.
 */
void wsSendSelectOption(uint8_t index);

/**
 * Send interrupt command.
 */
void wsSendInterrupt();

/**
 * Send escape command.
 */
void wsSendEscape();

/**
 * Timestamp (millis) of last reconnect attempt. Zero if never attempted.
 */
uint32_t wsLastAttemptMs();

/**
 * Current exponential backoff interval (capped at WS_RECONNECT_MAX_MS).
 */
uint32_t wsBackoffMs();

}  // namespace Net
