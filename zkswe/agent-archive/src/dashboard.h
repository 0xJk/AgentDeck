#pragma once

typedef struct {
    char state[32];        /* IDLE, PROCESSING, AWAITING_PERMISSION, etc */
    char projectName[64];
    char modelName[32];
    char agentType[32];
    char mode[16];         /* default, plan, accept */
    int  fiveHourPercent;
    int  sevenDayPercent;
    int  totalTokens;
    float totalCost;
    char currentTool[64];
    char options[4][64];
    int  optionCount;
} DashState;

void dashboard_init(void);
void dashboard_render(const DashState *state);
