/**
 * LVGL v9 configuration for AgentDeck ESP32 displays
 */
#ifndef LV_CONF_H
#define LV_CONF_H

#define LV_USE_DEV_VERSION

/* Color depth: 16-bit RGB565 */
#define LV_COLOR_DEPTH 16

/* Memory */
#define LV_MEM_CUSTOM 1  /* Use stdlib malloc/free (PSRAM) */

/* Display refresh */
#define LV_DEF_REFR_PERIOD 33  /* ~30fps */
#define LV_DPI_DEF 130

/* Drawing */
#define LV_DRAW_BUF_STRIDE_ALIGN 1
#define LV_DRAW_BUF_ALIGN 4
#define LV_USE_DRAW_SW 1
#define LV_USE_DRAW_SW_ASM LV_DRAW_SW_ASM_NONE

/* Fonts — built-in */
#define LV_FONT_MONTSERRAT_10 1
#define LV_FONT_MONTSERRAT_12 1
#define LV_FONT_MONTSERRAT_14 1
#define LV_FONT_MONTSERRAT_16 1
#define LV_FONT_MONTSERRAT_18 1
#define LV_FONT_MONTSERRAT_20 1
#define LV_FONT_DEFAULT &lv_font_montserrat_14

/* OS */
#define LV_USE_OS LV_OS_FREERTOS
#define LV_USE_FREERTOS 1

/* Widget usage */
#define LV_USE_LABEL 1
#define LV_USE_BTN 1
#define LV_USE_CANVAS 1
#define LV_USE_BAR 1
#define LV_USE_LINE 1
#define LV_USE_ARC 1
#define LV_USE_OBJ 1
#define LV_USE_IMG 0
#define LV_USE_ANIMIMG 0
#define LV_USE_ROLLER 0
#define LV_USE_SLIDER 1
#define LV_USE_SWITCH 0
#define LV_USE_TEXTAREA 1
#define LV_USE_TABLE 0
#define LV_USE_CHART 0
#define LV_USE_DROPDOWN 1
#define LV_USE_CHECKBOX 0

/* Animations */
#define LV_USE_ANIM 1

/* Misc */
#define LV_USE_LOG 1
#define LV_LOG_LEVEL LV_LOG_LEVEL_WARN
#define LV_USE_ASSERT_NULL 1
#define LV_USE_ASSERT_MALLOC 1
#define LV_USE_ASSERT_OBJ 0
#define LV_SPRINTF_CUSTOM 0

/* Gesture */
#define LV_USE_GESTURE_RECOGNITION 0
#define LV_INDEV_DEF_SCROLL_LIMIT 10
#define LV_INDEV_DEF_SCROLL_THROW 10
#define LV_INDEV_DEF_LONG_PRESS_TIME 400
#define LV_INDEV_DEF_LONG_PRESS_REP_TIME 100

#endif /* LV_CONF_H */
