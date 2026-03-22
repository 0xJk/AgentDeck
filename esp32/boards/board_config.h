#pragma once

// Board-specific pin configurations
// Selected at compile time via -DBOARD_xxx build flags

#if defined(BOARD_IPS_35)
    #include "board_35_ips.h"
#elif defined(BOARD_BOX_86)
    #include "board_86_box.h"
#elif defined(BOARD_ROUND_AMOLED)
    #include "board_round_amoled.h"
#elif defined(BOARD_ULANZI_TC001)
    #include "board_ulanzi_tc001.h"
#else
    #error "No board defined! Use -DBOARD_IPS_35, -DBOARD_BOX_86, -DBOARD_ROUND_AMOLED, or -DBOARD_ULANZI_TC001"
#endif
