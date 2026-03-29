#pragma once
#include "dashboard.h"

/* Parse a BridgeEvent JSON message and update DashState.
 * Returns 1 if state changed (needs re-render), 0 if no change. */
int protocol_parse(const char *json, int len, DashState *state);
