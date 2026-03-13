#include "display.h"
#include "config.h"
#include "../boards/board_config.h"
#include "fonts/font_noto_kr_12.h"

#include <lvgl.h>
#include <Arduino.h>

#if !defined(BOARD_ROUND_AMOLED) && !defined(BOARD_IPS_35)
#include <LovyanGFX.hpp>
#endif

// Platform-specific includes for ESP32-S3 Bus_RGB / Panel_RGB
#if defined(BOARD_BOX_86)
#include <lgfx/v1/platforms/esp32s3/Bus_RGB.hpp>
#include <lgfx/v1/platforms/esp32s3/Panel_RGB.hpp>
#endif


// ============================================================
// Board-specific display driver
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
// Requires Arduino_Canvas wrapper — direct QSPI writes produce black screen.
// Canvas buffers in PSRAM (~307KB), flush() sends to display.

#include <Arduino_GFX_Library.h>
#include <Wire.h>

static Arduino_DataBus* gfx_bus = nullptr;
static Arduino_GFX* gfx_raw = nullptr;       // Underlying AXS15231B display
static Arduino_Canvas* gfx_canvas = nullptr;  // Canvas wrapper (used for drawing)
static Arduino_GFX* gfx = nullptr;            // Points to gfx_canvas

// AXS15231B integrated touch read via I2C (addr 0x3B)
static bool touch_read_axs15231b(uint16_t* x, uint16_t* y) {
    Wire.beginTransmission(BOARD_TOUCH_ADDR);  // 0x3B
    Wire.write(0x01);  // Touch count register
    Wire.endTransmission(false);
    if (Wire.requestFrom((uint8_t)BOARD_TOUCH_ADDR, (uint8_t)6) < 6) return false;
    uint8_t buf[6];
    for (int i = 0; i < 6; i++) buf[i] = Wire.read();
    if (buf[0] == 0) return false;  // No touch
    uint16_t raw_x = ((buf[2] & 0x0F) << 8) | buf[3];
    uint16_t raw_y = ((buf[4] & 0x0F) << 8) | buf[5];
    // Landscape rotation: swap and mirror
    *x = raw_y;
    *y = BOARD_NATIVE_W - 1 - raw_x;
    return true;
}

#elif defined(BOARD_ROUND_AMOLED)
// ===== JC3636W518: ST77916 QSPI AMOLED =====
// Custom init: st77916_150 base + COLMOD 0x55 fix + gamma WRITE_C8_BYTES fix + OTP cal
// Panel is 1.5" variant (not 1.8") — uses different GIP/power values than default 180 init.

#include <Arduino_GFX_Library.h>
#include <Wire.h>

static const uint8_t st77916_jc3636w518_init[] = {
    BEGIN_WRITE,
    // Command set preamble (150 variant)
    WRITE_C8_D8, 0xF0, 0x28,
    WRITE_C8_D8, 0xF2, 0x28,
    WRITE_C8_D8, 0x73, 0xF0,
    WRITE_C8_D8, 0x7C, 0xD1,
    WRITE_C8_D8, 0x83, 0xE0,
    WRITE_C8_D8, 0x84, 0x61,
    WRITE_C8_D8, 0xF2, 0x82,
    WRITE_C8_D8, 0xF0, 0x00,
    WRITE_C8_D8, 0xF0, 0x01,
    WRITE_C8_D8, 0xF1, 0x01,
    // Power registers (150 variant)
    WRITE_C8_D8, 0xB0, 0x69, WRITE_C8_D8, 0xB1, 0x4A,
    WRITE_C8_D8, 0xB2, 0x2F, WRITE_C8_D8, 0xB3, 0x01,
    WRITE_C8_D8, 0xB4, 0x69, WRITE_C8_D8, 0xB5, 0x45,
    WRITE_C8_D8, 0xB6, 0xAB, WRITE_C8_D8, 0xB7, 0x41,
    WRITE_C8_D8, 0xB8, 0x86, WRITE_C8_D8, 0xB9, 0x15,
    WRITE_C8_D8, 0xBA, 0x00, WRITE_C8_D8, 0xBB, 0x08,
    WRITE_C8_D8, 0xBC, 0x08, WRITE_C8_D8, 0xBD, 0x00,
    WRITE_C8_D8, 0xBE, 0x00, WRITE_C8_D8, 0xBF, 0x07,
    // Frame rate
    WRITE_C8_D8, 0xC0, 0x80, WRITE_C8_D8, 0xC1, 0x10,
    WRITE_C8_D8, 0xC2, 0x37, WRITE_C8_D8, 0xC3, 0x80,
    WRITE_C8_D8, 0xC4, 0x10, WRITE_C8_D8, 0xC5, 0x37,
    // Power control
    WRITE_C8_D8, 0xC6, 0xA9, WRITE_C8_D8, 0xC7, 0x41,
    WRITE_C8_D8, 0xC8, 0x01, WRITE_C8_D8, 0xC9, 0xA9,
    WRITE_C8_D8, 0xCA, 0x41, WRITE_C8_D8, 0xCB, 0x01,
    WRITE_C8_D8, 0xCC, 0x7F, WRITE_C8_D8, 0xCD, 0x7F,
    WRITE_C8_D8, 0xCE, 0xFF,
    // Resolution
    WRITE_C8_D8, 0xD0, 0x91, WRITE_C8_D8, 0xD1, 0x68,
    WRITE_C8_D8, 0xD2, 0x68,
    WRITE_C8_D16, 0xF5, 0x00, 0xA5,
    WRITE_C8_D8, 0xF1, 0x10,
    WRITE_C8_D8, 0xF0, 0x00,
    // Gamma — WRITE_C8_BYTES sends via 0x02 (correct register, not RAMWRC)
    WRITE_C8_D8, 0xF0, 0x02,
    WRITE_C8_BYTES, 0xE0, 14,
    0xF0, 0x10, 0x18, 0x0D, 0x0C, 0x38, 0x3E, 0x44,
    0x51, 0x39, 0x15, 0x15, 0x30, 0x34,
    WRITE_C8_BYTES, 0xE1, 14,
    0xF0, 0x0F, 0x17, 0x0D, 0x0B, 0x07, 0x3E, 0x33,
    0x51, 0x39, 0x15, 0x15, 0x30, 0x34,
    WRITE_C8_D8, 0xF0, 0x10,
    // GIP (150 variant)
    WRITE_C8_D8, 0xF3, 0x10,
    WRITE_C8_D8, 0xE0, 0x08, WRITE_C8_D8, 0xE1, 0x00,
    WRITE_C8_D8, 0xE2, 0x00, WRITE_C8_D8, 0xE3, 0x00,
    WRITE_C8_D8, 0xE4, 0xE0, WRITE_C8_D8, 0xE5, 0x06,
    WRITE_C8_D8, 0xE6, 0x21, WRITE_C8_D8, 0xE7, 0x03,
    WRITE_C8_D8, 0xE8, 0x05, WRITE_C8_D8, 0xE9, 0x02,
    WRITE_C8_D8, 0xEA, 0xE9, WRITE_C8_D8, 0xEB, 0x00,
    WRITE_C8_D8, 0xEC, 0x00, WRITE_C8_D8, 0xED, 0x14,
    WRITE_C8_D8, 0xEE, 0xFF, WRITE_C8_D8, 0xEF, 0x00,
    WRITE_C8_D8, 0xF8, 0xFF, WRITE_C8_D8, 0xF9, 0x00,
    WRITE_C8_D8, 0xFA, 0x00, WRITE_C8_D8, 0xFB, 0x30,
    WRITE_C8_D8, 0xFC, 0x00, WRITE_C8_D8, 0xFD, 0x00,
    WRITE_C8_D8, 0xFE, 0x00, WRITE_C8_D8, 0xFF, 0x00,
    // Channel config
    WRITE_C8_D8, 0x60, 0x40, WRITE_C8_D8, 0x61, 0x05,
    WRITE_C8_D8, 0x62, 0x00, WRITE_C8_D8, 0x63, 0x42,
    WRITE_C8_D8, 0x64, 0xDA, WRITE_C8_D8, 0x65, 0x00,
    WRITE_C8_D8, 0x66, 0x00, WRITE_C8_D8, 0x67, 0x00,
    WRITE_C8_D8, 0x68, 0x00, WRITE_C8_D8, 0x69, 0x00,
    WRITE_C8_D8, 0x6A, 0x00, WRITE_C8_D8, 0x6B, 0x00,
    WRITE_C8_D8, 0x70, 0x40, WRITE_C8_D8, 0x71, 0x04,
    WRITE_C8_D8, 0x72, 0x00, WRITE_C8_D8, 0x73, 0x42,
    WRITE_C8_D8, 0x74, 0xD9, WRITE_C8_D8, 0x75, 0x00,
    WRITE_C8_D8, 0x76, 0x00, WRITE_C8_D8, 0x77, 0x00,
    WRITE_C8_D8, 0x78, 0x00, WRITE_C8_D8, 0x79, 0x00,
    WRITE_C8_D8, 0x7A, 0x00, WRITE_C8_D8, 0x7B, 0x00,
    // Gate driver (0x48 base)
    WRITE_C8_D8, 0x80, 0x48, WRITE_C8_D8, 0x81, 0x00,
    WRITE_C8_D8, 0x82, 0x07, WRITE_C8_D8, 0x83, 0x02,
    WRITE_C8_D8, 0x84, 0xD7, WRITE_C8_D8, 0x85, 0x04,
    WRITE_C8_D8, 0x86, 0x00, WRITE_C8_D8, 0x87, 0x00,
    WRITE_C8_D8, 0x88, 0x48, WRITE_C8_D8, 0x89, 0x00,
    WRITE_C8_D8, 0x8A, 0x09, WRITE_C8_D8, 0x8B, 0x02,
    WRITE_C8_D8, 0x8C, 0xD9, WRITE_C8_D8, 0x8D, 0x04,
    WRITE_C8_D8, 0x8E, 0x00, WRITE_C8_D8, 0x8F, 0x00,
    WRITE_C8_D8, 0x90, 0x48, WRITE_C8_D8, 0x91, 0x00,
    WRITE_C8_D8, 0x92, 0x0B, WRITE_C8_D8, 0x93, 0x02,
    WRITE_C8_D8, 0x94, 0xDB, WRITE_C8_D8, 0x95, 0x04,
    WRITE_C8_D8, 0x96, 0x00, WRITE_C8_D8, 0x97, 0x00,
    WRITE_C8_D8, 0x98, 0x48, WRITE_C8_D8, 0x99, 0x00,
    WRITE_C8_D8, 0x9A, 0x0D, WRITE_C8_D8, 0x9B, 0x02,
    WRITE_C8_D8, 0x9C, 0xDD, WRITE_C8_D8, 0x9D, 0x04,
    WRITE_C8_D8, 0x9E, 0x00, WRITE_C8_D8, 0x9F, 0x00,
    WRITE_C8_D8, 0xA0, 0x48, WRITE_C8_D8, 0xA1, 0x00,
    WRITE_C8_D8, 0xA2, 0x06, WRITE_C8_D8, 0xA3, 0x02,
    WRITE_C8_D8, 0xA4, 0xD6, WRITE_C8_D8, 0xA5, 0x04,
    WRITE_C8_D8, 0xA6, 0x00, WRITE_C8_D8, 0xA7, 0x00,
    WRITE_C8_D8, 0xA8, 0x48, WRITE_C8_D8, 0xA9, 0x00,
    WRITE_C8_D8, 0xAA, 0x08, WRITE_C8_D8, 0xAB, 0x02,
    WRITE_C8_D8, 0xAC, 0xD8, WRITE_C8_D8, 0xAD, 0x04,
    WRITE_C8_D8, 0xAE, 0x00, WRITE_C8_D8, 0xAF, 0x00,
    WRITE_C8_D8, 0xB0, 0x48, WRITE_C8_D8, 0xB1, 0x00,
    WRITE_C8_D8, 0xB2, 0x0A, WRITE_C8_D8, 0xB3, 0x02,
    WRITE_C8_D8, 0xB4, 0xDA, WRITE_C8_D8, 0xB5, 0x04,
    WRITE_C8_D8, 0xB6, 0x00, WRITE_C8_D8, 0xB7, 0x00,
    WRITE_C8_D8, 0xB8, 0x48, WRITE_C8_D8, 0xB9, 0x00,
    WRITE_C8_D8, 0xBA, 0x0C, WRITE_C8_D8, 0xBB, 0x02,
    WRITE_C8_D8, 0xBC, 0xDC, WRITE_C8_D8, 0xBD, 0x04,
    WRITE_C8_D8, 0xBE, 0x00, WRITE_C8_D8, 0xBF, 0x00,
    // Gate mapping
    WRITE_C8_D8, 0xC0, 0x10, WRITE_C8_D8, 0xC1, 0x47,
    WRITE_C8_D8, 0xC2, 0x56, WRITE_C8_D8, 0xC3, 0x65,
    WRITE_C8_D8, 0xC4, 0x74, WRITE_C8_D8, 0xC5, 0x88,
    WRITE_C8_D8, 0xC6, 0x99, WRITE_C8_D8, 0xC7, 0x01,
    WRITE_C8_D8, 0xC8, 0xBB, WRITE_C8_D8, 0xC9, 0xAA,
    WRITE_C8_D8, 0xD0, 0x10, WRITE_C8_D8, 0xD1, 0x47,
    WRITE_C8_D8, 0xD2, 0x56, WRITE_C8_D8, 0xD3, 0x65,
    WRITE_C8_D8, 0xD4, 0x74, WRITE_C8_D8, 0xD5, 0x88,
    WRITE_C8_D8, 0xD6, 0x99, WRITE_C8_D8, 0xD7, 0x01,
    WRITE_C8_D8, 0xD8, 0xBB, WRITE_C8_D8, 0xD9, 0xAA,
    // Exit GIP
    WRITE_C8_D8, 0xF3, 0x01,
    WRITE_C8_D8, 0xF0, 0x00,
    // OTP calibration (factory trim)
    WRITE_C8_D8, 0xF0, 0x01,
    WRITE_C8_D8, 0xF1, 0x01,
    WRITE_C8_D8, 0xA0, 0x0B,
    WRITE_C8_D8, 0xA3, 0x2A, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x2B, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x2C, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x2D, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x2E, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x2F, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x30, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x31, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x32, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x33, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA0, 0x09,
    WRITE_C8_D8, 0xF1, 0x10,
    WRITE_C8_D8, 0xF0, 0x00,
    // CASET/RASET + RAM clear
    WRITE_C8_BYTES, 0x2A, 4, 0x00, 0x00, 0x01, 0x67,
    WRITE_C8_BYTES, 0x2B, 4, 0x01, 0x68, 0x01, 0x68,
    WRITE_C8_D8, 0x4D, 0x00, WRITE_C8_D8, 0x4E, 0x00,
    WRITE_C8_D8, 0x4F, 0x00, WRITE_C8_D8, 0x4C, 0x01,
    END_WRITE, DELAY, 10, BEGIN_WRITE,
    WRITE_C8_D8, 0x4C, 0x00,
    WRITE_C8_BYTES, 0x2A, 4, 0x00, 0x00, 0x01, 0x67,
    WRITE_C8_BYTES, 0x2B, 4, 0x00, 0x00, 0x01, 0x67,
    // Display on
    WRITE_C8_D8, 0x3A, 0x55,  // COLMOD RGB565
    WRITE_COMMAND_8, 0x21,     // INVON
    WRITE_COMMAND_8, 0x11,     // SLPOUT
    END_WRITE,
    DELAY, 120,
    BEGIN_WRITE,
    WRITE_COMMAND_8, 0x29,     // DISPON
    WRITE_COMMAND_8, 0x2C,     // RAMWR
    END_WRITE,
};

static Arduino_DataBus* gfx_bus = nullptr;
static Arduino_GFX* gfx = nullptr;

// CST816S touch read via Wire I2C
static bool touch_read_cst816s(uint16_t* x, uint16_t* y) {
    Wire.beginTransmission(BOARD_TOUCH_ADDR);
    Wire.write(0x01);  // Num touch points register
    Wire.endTransmission(false);
    if (Wire.requestFrom((uint8_t)BOARD_TOUCH_ADDR, (uint8_t)6) < 6) return false;
    uint8_t buf[6];
    for (int i = 0; i < 6; i++) buf[i] = Wire.read();
    if (buf[0] == 0) return false;
    *x = ((buf[2] & 0x0F) << 8) | buf[3];
    *y = ((buf[4] & 0x0F) << 8) | buf[5];
    return true;
}

#else
#error "No board defined — cannot configure display"
#endif

// ============================================================
// Common LVGL integration
// ============================================================

#if !defined(BOARD_ROUND_AMOLED) && !defined(BOARD_IPS_35)
static LGFX tft;
#endif
static lv_display_t* disp = nullptr;

// Montserrat 12 + Korean fallback (initialized in displayInit)
lv_font_t font_kr_12;

// LVGL flush callback
static void disp_flush(lv_display_t* display, const lv_area_t* area, uint8_t* px_map) {
    uint32_t w = (area->x2 - area->x1 + 1);
    uint32_t h = (area->y2 - area->y1 + 1);

#if defined(BOARD_BOX_86)
    // RGB panel: pushImage writes directly to DMA framebuffer
    // swap565_t tells LovyanGFX data is already byte-swapped (RGB565_SWAPPED from LVGL)
    tft.pushImage(area->x1, area->y1, w, h, (lgfx::swap565_t*)px_map);
#elif defined(BOARD_IPS_35)
    // AXS15231B via Canvas: draw partial area to buffer, flush only on last area
    gfx->draw16bitBeRGBBitmap(area->x1, area->y1, (uint16_t*)px_map, w, h);
    if (lv_display_flush_is_last(display)) {
        gfx_canvas->flush();
    }
#elif defined(BOARD_ROUND_AMOLED)
    // ST77916 QSPI: direct draw (no Canvas needed)
    gfx->draw16bitBeRGBBitmap(area->x1, area->y1, (uint16_t*)px_map, w, h);
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
#if defined(BOARD_ROUND_AMOLED)
    if (touch_read_cst816s(&x, &y)) {
#elif defined(BOARD_IPS_35)
    if (touch_read_axs15231b(&x, &y)) {
#else
    if (tft.getTouch(&x, &y)) {
#endif
        data->point.x = x;
        data->point.y = y;
        data->state = LV_INDEV_STATE_PRESSED;
    } else {
        data->state = LV_INDEV_STATE_RELEASED;
    }
}

namespace UI {

void displayInit() {
#if defined(BOARD_ROUND_AMOLED)
    // === ST77916 QSPI AMOLED init via Arduino_GFX ===

    // Wait for USB CDC Serial to enumerate (native JTAG USB)
    delay(2000);
    Serial.println("[Display] === Round AMOLED ST77916 via Arduino_GFX ===");

    // AMOLED power enable
    pinMode(BOARD_PIN_BL, OUTPUT);
    digitalWrite(BOARD_PIN_BL, HIGH);
    delay(200);

    // Create Arduino_GFX QSPI bus and ST77916 display
    gfx_bus = new Arduino_ESP32QSPI(
        BOARD_PIN_QSPI_CS, BOARD_PIN_QSPI_CLK,
        BOARD_PIN_QSPI_D0, BOARD_PIN_QSPI_D1,
        BOARD_PIN_QSPI_D2, BOARD_PIN_QSPI_D3);
    gfx = new Arduino_ST77916(
        gfx_bus, BOARD_PIN_RST, 0 /* rotation */, true /* IPS */,
        360, 360, 0, 0, 0, 0,
        st77916_jc3636w518_init, sizeof(st77916_jc3636w518_init));

    if (!gfx->begin(40000000)) {  // 40MHz QSPI clock
        Serial.println("[Display] gfx->begin() FAILED!");
    } else {
        Serial.println("[Display] gfx->begin() OK");
    }
    gfx->fillScreen(RGB565_BLACK);

    // Init touch I2C
    pinMode(BOARD_PIN_TOUCH_RST, OUTPUT);
    digitalWrite(BOARD_PIN_TOUCH_RST, LOW);
    delay(10);
    digitalWrite(BOARD_PIN_TOUCH_RST, HIGH);
    delay(50);
    Wire.begin(BOARD_PIN_TOUCH_SDA, BOARD_PIN_TOUCH_SCL);
    Serial.println("[Display] Touch CST816S initialized");

#elif defined(BOARD_IPS_35)
    // === AXS15231B QSPI IPS init via Arduino_GFX ===

    // Wait for USB CDC Serial to enumerate (native JTAG USB)
    delay(2000);
    Serial.println("[Display] === IPS 3.5\" AXS15231B via Arduino_GFX ===");

    // Backlight ON (PWM capable but start with full brightness)
    pinMode(BOARD_PIN_BL, OUTPUT);
    digitalWrite(BOARD_PIN_BL, HIGH);
    delay(100);

    // Create QSPI bus → AXS15231B display → Canvas wrapper
    gfx_bus = new Arduino_ESP32QSPI(
        BOARD_PIN_QSPI_CS, BOARD_PIN_QSPI_CLK,
        BOARD_PIN_QSPI_D0, BOARD_PIN_QSPI_D1,
        BOARD_PIN_QSPI_D2, BOARD_PIN_QSPI_D3);
    gfx_raw = new Arduino_AXS15231B(gfx_bus, GFX_NOT_DEFINED /* RST */,
        0 /* rotation */, false /* IPS */, 320, 480,
        0, 0, 0, 0,
        axs15231b_320480_type1_init_operations,
        sizeof(axs15231b_320480_type1_init_operations));
    gfx_canvas = new Arduino_Canvas(320, 480, gfx_raw);
    gfx = gfx_canvas;  // All drawing goes through Canvas

    if (!gfx->begin()) {  // Default 32MHz QSPI
        Serial.println("[Display] gfx->begin() FAILED!");
    } else {
        Serial.println("[Display] gfx->begin() OK");
    }
    gfx->setRotation(1);  // Landscape: 480x320
    gfx->fillScreen(RGB565_BLACK);
    gfx_canvas->flush();
    Serial.println("[Display] Canvas initialized and flushed");

    // Touch I2C init
    pinMode(BOARD_PIN_TOUCH_RST, OUTPUT);
    digitalWrite(BOARD_PIN_TOUCH_RST, LOW);
    delay(10);
    digitalWrite(BOARD_PIN_TOUCH_RST, HIGH);
    delay(50);
    Wire.begin(BOARD_PIN_TOUCH_SDA, BOARD_PIN_TOUCH_SCL);
    Serial.println("[Display] Touch AXS15231B initialized");

#else
    // LovyanGFX path for BOX_86
    Serial.println("[Display] Calling tft.init()...");
    tft.init();
    Serial.println("[Display] tft.init() complete");
    tft.setRotation(BOARD_ROTATION);
    tft.setBrightness(255);
#endif

    lv_init();

    // Korean font fallback: create a RAM copy of montserrat_12 with fallback pointer set.
    // Can't modify the built-in font directly (it's in flash .rodata).
    // Instead, each UI file that needs Korean should use &font_kr_12 from display.h.
    font_kr_12 = lv_font_montserrat_12;  // Copy struct to RAM
    font_kr_12.fallback = &font_noto_kr_12;  // Set Korean fallback

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
    // SPI/QSPI panels: partial render with DMA-capable buffers, big-endian RGB565
    static constexpr size_t BUF_LINES = 40;
    size_t bufPixels = SCREEN_W * BUF_LINES;
    size_t bufSize = bufPixels * sizeof(uint16_t);
    // DMA-capable aligned buffers (Arduino_GFX pattern)
    uint16_t* buf1 = (uint16_t*)heap_caps_aligned_alloc(16, bufSize, MALLOC_CAP_DMA);
    uint16_t* buf2 = (uint16_t*)heap_caps_aligned_alloc(16, bufSize, MALLOC_CAP_DMA);
    if (!buf1 || !buf2) {
        // Fallback to PSRAM
        if (buf1) free(buf1);
        if (buf2) free(buf2);
        buf1 = (uint16_t*)ps_malloc(bufSize);
        buf2 = (uint16_t*)ps_malloc(bufSize);
        Serial.println("[Display] DMA alloc failed, using PSRAM");
    }
    if (!buf1 || !buf2) {
        Serial.println("[Display] Buffer alloc failed!");
        return;
    }
    lv_display_set_color_format(disp, LV_COLOR_FORMAT_RGB565_SWAPPED);
    lv_display_set_buffers(disp, buf1, buf2, bufSize,
                           LV_DISPLAY_RENDER_MODE_PARTIAL);
    Serial.printf("[Display] LVGL initialized %dx%d (RGB565 swapped)\n", SCREEN_W, SCREEN_H);
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
#if defined(BOARD_ROUND_AMOLED)
    // AMOLED: simple on/off via BL pin (no PWM)
    digitalWrite(BOARD_PIN_BL, level > 0 ? HIGH : LOW);
#elif defined(BOARD_IPS_35)
    // AXS15231B: PWM backlight
    analogWrite(BOARD_PIN_BL, level);
#else
    tft.setBrightness(level);
#endif
}

void lvglTick() {
    lv_tick_inc(LVGL_TICK_MS);
}

void lvglLoop() {
    lv_timer_handler();
}

}  // namespace UI
