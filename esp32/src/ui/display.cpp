#include "display.h"
#include "config.h"
#include "../boards/board_config.h"
#include "fonts/font_noto_kr_12.h"

#include <lvgl.h>
#include <LovyanGFX.hpp>
#include <Arduino.h>

// Platform-specific includes for ESP32-S3 Bus_RGB / Panel_RGB
#if defined(BOARD_BOX_86)
#include <lgfx/v1/platforms/esp32s3/Bus_RGB.hpp>
#include <lgfx/v1/platforms/esp32s3/Panel_RGB.hpp>
#endif

// ============================================================
// Board-specific LovyanGFX display class
// ============================================================

#if defined(BOARD_BOX_86)
// ===== ESP32-S3-4848S040: ST7701 RGB 16-bit parallel =====
// Verified pin map from factory firmware backup.
// ST7701 init via 3-wire SPI, display via RGB parallel bus.
class LGFX : public lgfx::LGFX_Device {
public:
    lgfx::Bus_RGB        _bus_instance;
    lgfx::Panel_ST7701_guition_esp32_4848S040 _panel_instance;
    lgfx::Light_PWM      _light_instance;
    lgfx::Touch_GT911    _touch_instance;

    LGFX() {
        // RGB parallel bus configuration
        {
            auto cfg = _bus_instance.config();
            cfg.freq_write = 10000000;  // 10MHz — balance between tearing and refresh rate
            cfg.panel = &_panel_instance;  // CRITICAL: Bus_RGB needs panel pointer

            cfg.pin_pclk    = BOARD_PIN_PCLK;   // 21
            cfg.pin_vsync   = BOARD_PIN_VSYNC;  // 17
            cfg.pin_hsync   = BOARD_PIN_HSYNC;  // 16
            cfg.pin_henable = BOARD_PIN_DE;      // 18

            // RGB565 data pins
            cfg.pin_d0  = BOARD_PIN_B0;   // 4
            cfg.pin_d1  = BOARD_PIN_B1;   // 5
            cfg.pin_d2  = BOARD_PIN_B2;   // 6
            cfg.pin_d3  = BOARD_PIN_B3;   // 7
            cfg.pin_d4  = BOARD_PIN_B4;   // 15
            cfg.pin_d5  = BOARD_PIN_G0;   // 8
            cfg.pin_d6  = BOARD_PIN_G1;   // 20
            cfg.pin_d7  = BOARD_PIN_G2;   // 3
            cfg.pin_d8  = BOARD_PIN_G3;   // 46
            cfg.pin_d9  = BOARD_PIN_G4;   // 9
            cfg.pin_d10 = BOARD_PIN_G5;   // 10
            cfg.pin_d11 = BOARD_PIN_R0;   // 11
            cfg.pin_d12 = BOARD_PIN_R1;   // 12
            cfg.pin_d13 = BOARD_PIN_R2;   // 13
            cfg.pin_d14 = BOARD_PIN_R3;   // 14
            cfg.pin_d15 = BOARD_PIN_R4;   // 0

            cfg.hsync_pulse_width  = 8;
            cfg.hsync_back_porch   = 50;
            cfg.hsync_front_porch  = 10;
            cfg.hsync_polarity     = 0;

            cfg.vsync_pulse_width  = 8;
            cfg.vsync_back_porch   = 20;
            cfg.vsync_front_porch  = 10;
            cfg.vsync_polarity     = 0;

            cfg.pclk_active_neg    = 0;
            cfg.de_idle_high       = 1;
            cfg.pclk_idle_high     = 0;

            _bus_instance.config(cfg);
        }
        _panel_instance.setBus(&_bus_instance);

        // Panel configuration
        {
            auto cfg = _panel_instance.config();
            cfg.memory_width  = 480;
            cfg.memory_height = 480;
            cfg.panel_width   = 480;
            cfg.panel_height  = 480;
            cfg.offset_x      = 0;
            cfg.offset_y      = 0;
            _panel_instance.config(cfg);
        }

        // ST7701 init via 3-wire SPI
        {
            auto cfg = _panel_instance.config_detail();
            cfg.pin_cs   = BOARD_PIN_3WIRE_CS;    // 39
            cfg.pin_sclk = BOARD_PIN_3WIRE_CLK;   // 48
            cfg.pin_mosi = BOARD_PIN_3WIRE_MOSI;  // 47
            _panel_instance.config_detail(cfg);
        }

        // Backlight
        {
            auto cfg = _light_instance.config();
            cfg.pin_bl = BOARD_PIN_BL;  // 38
            cfg.invert = false;
            cfg.freq   = 12000;
            cfg.pwm_channel = 0;
            _light_instance.config(cfg);
            _panel_instance.setLight(&_light_instance);
        }

        // Touch: GT911 I2C
        {
            auto cfg = _touch_instance.config();
            cfg.i2c_port = 0;
            cfg.i2c_addr = BOARD_TOUCH_ADDR;      // 0x5D
            cfg.pin_sda  = BOARD_PIN_TOUCH_SDA;    // 19
            cfg.pin_scl  = BOARD_PIN_TOUCH_SCL;    // 45
            cfg.pin_int  = BOARD_PIN_TOUCH_INT;     // -1
            cfg.pin_rst  = BOARD_PIN_TOUCH_RST;     // -1
            cfg.x_min = 0;
            cfg.x_max = 479;
            cfg.y_min = 0;
            cfg.y_max = 479;
            _touch_instance.config(cfg);
            _panel_instance.setTouch(&_touch_instance);
        }

        setPanel(&_panel_instance);
    }
};

#elif defined(BOARD_IPS_35)
// ===== JC3248W535: AXS15231B QSPI =====
// QSPI not natively supported by LovyanGFX — use generic SPI with custom init.
// TODO: Implement via esp_lcd QSPI driver for proper support.
class LGFX : public lgfx::LGFX_Device {
public:
    lgfx::Bus_SPI        _bus_instance;
    lgfx::Panel_ST7789   _panel_instance;  // Fallback — init commands override
    lgfx::Light_PWM      _light_instance;
    lgfx::Touch_GT911    _touch_instance;

    LGFX() {
        // SPI bus (single-line fallback — QSPI needs esp_lcd for full speed)
        {
            auto cfg = _bus_instance.config();
            cfg.spi_host = SPI2_HOST;
            cfg.freq_write = 40000000;
            cfg.pin_sclk = BOARD_PIN_QSPI_CLK;  // 47
            cfg.pin_mosi = BOARD_PIN_QSPI_D0;   // 21
            cfg.pin_miso = -1;
            cfg.pin_dc   = -1;  // DC via command bit for QSPI panels
            _bus_instance.config(cfg);
        }
        _panel_instance.setBus(&_bus_instance);

        {
            auto cfg = _panel_instance.config();
            cfg.pin_cs   = BOARD_PIN_QSPI_CS;  // 45
            cfg.pin_rst  = -1;
            cfg.pin_busy = -1;
            cfg.memory_width  = BOARD_NATIVE_W;   // 320
            cfg.memory_height = BOARD_NATIVE_H;    // 480
            cfg.panel_width   = BOARD_NATIVE_W;
            cfg.panel_height  = BOARD_NATIVE_H;
            cfg.offset_rotation = BOARD_ROTATION;
            _panel_instance.config(cfg);
        }

        {
            auto cfg = _light_instance.config();
            cfg.pin_bl = BOARD_PIN_BL;  // 1
            cfg.invert = false;
            cfg.freq   = 12000;
            cfg.pwm_channel = 0;
            _light_instance.config(cfg);
            _panel_instance.setLight(&_light_instance);
        }

        {
            auto cfg = _touch_instance.config();
            cfg.i2c_port = 0;
            cfg.i2c_addr = BOARD_TOUCH_ADDR;
            cfg.pin_sda  = BOARD_PIN_TOUCH_SDA;
            cfg.pin_scl  = BOARD_PIN_TOUCH_SCL;
            cfg.pin_int  = BOARD_PIN_TOUCH_INT;
            cfg.pin_rst  = BOARD_PIN_TOUCH_RST;
            cfg.x_min = 0;
            cfg.x_max = BOARD_NATIVE_W - 1;
            cfg.y_min = 0;
            cfg.y_max = BOARD_NATIVE_H - 1;
            _touch_instance.config(cfg);
            _panel_instance.setTouch(&_touch_instance);
        }

        setPanel(&_panel_instance);
    }
};

#elif defined(BOARD_ROUND_AMOLED)
// ===== JC3636W518: ST77916 QSPI =====
// Using Panel_ST77961 (closest available) — ST77916 is register-compatible.
// TODO: Implement via esp_lcd QSPI driver for proper support.
class LGFX : public lgfx::LGFX_Device {
public:
    lgfx::Bus_SPI        _bus_instance;
    lgfx::Panel_ST77961  _panel_instance;
    lgfx::Light_PWM      _light_instance;
    lgfx::Touch_CST816S  _touch_instance;

    LGFX() {
        {
            auto cfg = _bus_instance.config();
            cfg.spi_host = SPI2_HOST;
            cfg.freq_write = 40000000;
            cfg.pin_sclk = BOARD_PIN_QSPI_CLK;  // 13
            cfg.pin_mosi = BOARD_PIN_QSPI_D0;   // 15
            cfg.pin_miso = -1;
            cfg.pin_dc   = -1;
            _bus_instance.config(cfg);
        }
        _panel_instance.setBus(&_bus_instance);

        {
            auto cfg = _panel_instance.config();
            cfg.pin_cs   = BOARD_PIN_QSPI_CS;  // 14
            cfg.pin_rst  = BOARD_PIN_RST;       // 21
            cfg.pin_busy = -1;
            cfg.memory_width  = BOARD_NATIVE_W;
            cfg.memory_height = BOARD_NATIVE_H;
            cfg.panel_width   = BOARD_NATIVE_W;
            cfg.panel_height  = BOARD_NATIVE_H;
            _panel_instance.config(cfg);
        }

        {
            auto cfg = _light_instance.config();
            cfg.pin_bl = BOARD_PIN_BL;  // 47
            cfg.invert = false;
            cfg.freq   = 12000;
            cfg.pwm_channel = 0;
            _light_instance.config(cfg);
            _panel_instance.setLight(&_light_instance);
        }

        {
            auto cfg = _touch_instance.config();
            cfg.i2c_port = 0;
            cfg.i2c_addr = BOARD_TOUCH_ADDR;
            cfg.pin_sda  = BOARD_PIN_TOUCH_SDA;
            cfg.pin_scl  = BOARD_PIN_TOUCH_SCL;
            cfg.pin_int  = BOARD_PIN_TOUCH_INT;
            cfg.pin_rst  = BOARD_PIN_TOUCH_RST;
            cfg.x_min = 0;
            cfg.x_max = BOARD_NATIVE_W - 1;
            cfg.y_min = 0;
            cfg.y_max = BOARD_NATIVE_H - 1;
            _touch_instance.config(cfg);
            _panel_instance.setTouch(&_touch_instance);
        }

        setPanel(&_panel_instance);
    }
};

#else
#error "No board defined — cannot configure display"
#endif

// ============================================================
// Common LVGL integration
// ============================================================

static LGFX tft;
static lv_display_t* disp = nullptr;

// LVGL flush callback
static void disp_flush(lv_display_t* display, const lv_area_t* area, uint8_t* px_map) {
    uint32_t w = (area->x2 - area->x1 + 1);
    uint32_t h = (area->y2 - area->y1 + 1);

#if defined(BOARD_BOX_86)
    // RGB panel: pushImage writes directly to DMA framebuffer
    // swap565_t tells LovyanGFX data is already byte-swapped (RGB565_SWAPPED from LVGL)
    tft.pushImage(area->x1, area->y1, w, h, (lgfx::swap565_t*)px_map);
#else
    tft.startWrite();
    tft.setAddrWindow(area->x1, area->y1, w, h);
    tft.writePixels((uint16_t*)px_map, w * h);
    tft.endWrite();
#endif

    lv_display_flush_ready(display);
}

// LVGL touch read callback
static void touch_read(lv_indev_t* indev, lv_indev_data_t* data) {
    uint16_t x, y;
    if (tft.getTouch(&x, &y)) {
        data->point.x = x;
        data->point.y = y;
        data->state = LV_INDEV_STATE_PRESSED;
    } else {
        data->state = LV_INDEV_STATE_RELEASED;
    }
}

namespace UI {

void displayInit() {
    tft.init();
    tft.setRotation(BOARD_ROTATION);
    tft.setBrightness(255);

    lv_init();

    // Set Korean font as fallback for montserrat_12 (used in HUD, timeline, name tags)
    const_cast<lv_font_t&>(lv_font_montserrat_12).fallback = &font_noto_kr_12;

    disp = lv_display_create(SCREEN_W, SCREEN_H);
    lv_display_set_flush_cb(disp, disp_flush);

#if defined(BOARD_BOX_86)
    // RGB panel: LVGL renders into internal SRAM buffer (fast), then memcpy to DMA
    // RGB565_SWAPPED = LVGL outputs big-endian RGB565 matching DMA byte order
    // Use internal SRAM (not PSRAM) for LVGL buffer to avoid PSRAM bus contention
    static constexpr size_t BUF_LINES = 40;
    size_t bufPixels = SCREEN_W * BUF_LINES;
    size_t bufSize = bufPixels * sizeof(uint16_t);
    // Try internal SRAM first for speed, fall back to PSRAM
    uint16_t* buf1 = (uint16_t*)heap_caps_malloc(bufSize, MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
    uint16_t* buf2 = (uint16_t*)heap_caps_malloc(bufSize, MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
    if (!buf1 || !buf2) {
        // Fallback to PSRAM
        if (buf1) free(buf1);
        if (buf2) free(buf2);
        buf1 = (uint16_t*)ps_malloc(bufSize);
        buf2 = (uint16_t*)ps_malloc(bufSize);
        Serial.println("[Display] Using PSRAM buffers (SRAM unavailable)");
    } else {
        Serial.println("[Display] Using internal SRAM buffers (fast)");
    }
    if (!buf1 || !buf2) {
        Serial.println("[Display] Buffer alloc failed!");
        return;
    }
    lv_display_set_color_format(disp, LV_COLOR_FORMAT_RGB565_SWAPPED);
    lv_display_set_buffers(disp, buf1, buf2, bufSize,
                           LV_DISPLAY_RENDER_MODE_PARTIAL);
    Serial.printf("[Display] LVGL initialized %dx%d (RGB565 swapped, partial)\n", SCREEN_W, SCREEN_H);
#else
    // SPI panels: partial render with double PSRAM buffer
    static constexpr size_t BUF_LINES = 40;
    size_t bufPixels = SCREEN_W * BUF_LINES;
    size_t bufSize = bufPixels * sizeof(uint16_t);
    uint16_t* buf1 = (uint16_t*)ps_malloc(bufSize);
    uint16_t* buf2 = (uint16_t*)ps_malloc(bufSize);
    if (!buf1 || !buf2) {
        Serial.println("[Display] PSRAM alloc failed!");
        return;
    }
    lv_display_set_buffers(disp, buf1, buf2, bufSize,
                           LV_DISPLAY_RENDER_MODE_PARTIAL);
    Serial.printf("[Display] LVGL initialized %dx%d\n", SCREEN_W, SCREEN_H);
#endif

    lv_indev_t* indev = lv_indev_create();
    lv_indev_set_type(indev, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(indev, touch_read);
}

lv_display_t* getDisplay() {
    return disp;
}

void setBrightness(int level) {
    if (level < 0) level = 0;
    if (level > 255) level = 255;
    tft.setBrightness(level);
}

void lvglTick() {
    lv_tick_inc(LVGL_TICK_MS);
}

void lvglLoop() {
    lv_timer_handler();
}

}  // namespace UI
