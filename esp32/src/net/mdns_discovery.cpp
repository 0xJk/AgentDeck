#include "mdns_discovery.h"
#include <ESPmDNS.h>
#include "config.h"

static Net::BridgeInfo discovered;
static bool hasNew = false;
static uint32_t lastQueryMs = 0;
constexpr uint32_t QUERY_INTERVAL_MS = 5000;

namespace Net {

void mdnsInit() {
    if (!MDNS.begin("agentdeck-display")) {
        Serial.println("[mDNS] Failed to start");
        return;
    }
    Serial.println("[mDNS] Started, browsing for _agentdeck._tcp");
    memset(&discovered, 0, sizeof(discovered));
}

bool mdnsPoll(BridgeInfo& out) {
    uint32_t now = millis();
    if (now - lastQueryMs < QUERY_INTERVAL_MS) {
        if (hasNew) {
            out = discovered;
            hasNew = false;
            return true;
        }
        return false;
    }
    lastQueryMs = now;

    int n = MDNS.queryService("_agentdeck", "_tcp");
    if (n <= 0) return false;

    // Pick first available service
    for (int i = 0; i < n; i++) {
#if defined(BOARD_ROUND_AMOLED) || defined(BOARD_IPS_35)
        IPAddress ip = MDNS.address(i);  // ESP-IDF 5.x
#else
        IPAddress ip = MDNS.IP(i);       // ESP-IDF 4.4
#endif
        uint16_t port = MDNS.port(i);
        if (port == 0) continue;

        snprintf(discovered.ip, sizeof(discovered.ip),
                 "%d.%d.%d.%d", ip[0], ip[1], ip[2], ip[3]);
        discovered.port = port;
        discovered.found = true;

        // Parse TXT records
        int numKeys = MDNS.numTxt(i);
        for (int k = 0; k < numKeys; k++) {
            String key = MDNS.txtKey(i, k);
            String val = MDNS.txt(i, k);
            if (key == "token") {
                strncpy(discovered.token, val.c_str(), sizeof(discovered.token) - 1);
            } else if (key == "project") {
                strncpy(discovered.project, val.c_str(), sizeof(discovered.project) - 1);
            } else if (key == "agent") {
                strncpy(discovered.agent, val.c_str(), sizeof(discovered.agent) - 1);
            }
        }

        Serial.printf("[mDNS] Found bridge: %s:%d project=%s\n",
                       discovered.ip, discovered.port, discovered.project);
        hasNew = true;
        out = discovered;
        return true;
    }
    return false;
}

void mdnsRefresh() {
    lastQueryMs = 0;  // Force next poll to query immediately
}

}  // namespace Net
