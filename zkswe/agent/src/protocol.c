#include "protocol.h"
#include "../lib/cJSON.h"
#include <string.h>
#include <stdio.h>

static void safe_copy(char *dst, int dstlen, const cJSON *obj, const char *key) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (cJSON_IsString(v) && v->valuestring) {
        strncpy(dst, v->valuestring, dstlen - 1);
        dst[dstlen - 1] = 0;
    }
}

static int safe_int(const cJSON *obj, const char *key, int def) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsNumber(v) ? (int)v->valuedouble : def;
}

static double safe_double(const cJSON *obj, const char *key, double def) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsNumber(v) ? v->valuedouble : def;
}

int protocol_parse(const char *json, int len, DashState *state) {
    cJSON *doc = cJSON_ParseWithLength(json, len);
    if (!doc) return 0;

    const cJSON *type = cJSON_GetObjectItemCaseSensitive(doc, "type");
    if (!cJSON_IsString(type)) { cJSON_Delete(doc); return 0; }

    int changed = 0;

    if (strcmp(type->valuestring, "state_update") == 0) {
        safe_copy(state->state, sizeof(state->state), doc, "state");
        safe_copy(state->projectName, sizeof(state->projectName), doc, "projectName");
        safe_copy(state->modelName, sizeof(state->modelName), doc, "modelName");
        safe_copy(state->agentType, sizeof(state->agentType), doc, "agentType");
        safe_copy(state->mode, sizeof(state->mode), doc, "mode");
        safe_copy(state->currentTool, sizeof(state->currentTool), doc, "currentTool");

        /* Options */
        const cJSON *opts = cJSON_GetObjectItemCaseSensitive(doc, "options");
        state->optionCount = 0;
        if (cJSON_IsArray(opts)) {
            int n = cJSON_GetArraySize(opts);
            if (n > 4) n = 4;
            for (int i = 0; i < n; i++) {
                const cJSON *o = cJSON_GetArrayItem(opts, i);
                if (cJSON_IsString(o)) {
                    strncpy(state->options[i], o->valuestring, 63);
                    state->options[i][63] = 0;
                } else if (cJSON_IsObject(o)) {
                    safe_copy(state->options[i], sizeof(state->options[i]), o, "label");
                }
                state->optionCount++;
            }
        }
        changed = 1;

    } else if (strcmp(type->valuestring, "usage_update") == 0) {
        state->fiveHourPercent = safe_int(doc, "fiveHourPercent", state->fiveHourPercent);
        state->sevenDayPercent = safe_int(doc, "sevenDayPercent", state->sevenDayPercent);
        state->totalTokens = safe_int(doc, "totalTokens", state->totalTokens);
        state->totalCost = (float)safe_double(doc, "totalCost", state->totalCost);
        changed = 1;
    }

    cJSON_Delete(doc);
    return changed;
}
