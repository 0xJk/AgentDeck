// Arduino_GFX ST77916 QSPI test on ESP-IDF 5.x (pioarduino)
// JC3636W518 Round AMOLED 360x360
// st77916_150 init + COLMOD fix (0x05→0x55) + gamma WRITE_C8_BYTES fix

#include <Arduino.h>
#include <Arduino_GFX_Library.h>

#define PIN_CS    10
#define PIN_CLK   9
#define PIN_D0    11
#define PIN_D1    12
#define PIN_D2    13
#define PIN_D3    14
#define PIN_RST   47
#define PIN_BL    15

// Custom init: st77916_150 with two fixes:
// 1. Gamma E0/E1: WRITE_BYTES → WRITE_C8_BYTES (sends via 0x02 instead of 0x32)
// 2. COLMOD: 0x05 → 0x55 (full RGB565 for both interfaces)
static const uint8_t st77916_custom_init[] = {
    BEGIN_WRITE,
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
    // Power registers
    WRITE_C8_D8, 0xB0, 0x69,
    WRITE_C8_D8, 0xB1, 0x4A,
    WRITE_C8_D8, 0xB2, 0x2F,
    WRITE_C8_D8, 0xB3, 0x01,
    WRITE_C8_D8, 0xB4, 0x69,
    WRITE_C8_D8, 0xB5, 0x45,
    WRITE_C8_D8, 0xB6, 0xAB,
    WRITE_C8_D8, 0xB7, 0x41,
    WRITE_C8_D8, 0xB8, 0x86,
    WRITE_C8_D8, 0xB9, 0x15,
    WRITE_C8_D8, 0xBA, 0x00,
    WRITE_C8_D8, 0xBB, 0x08,
    WRITE_C8_D8, 0xBC, 0x08,
    WRITE_C8_D8, 0xBD, 0x00,
    WRITE_C8_D8, 0xBE, 0x00,
    WRITE_C8_D8, 0xBF, 0x07,
    // Frame rate
    WRITE_C8_D8, 0xC0, 0x80,
    WRITE_C8_D8, 0xC1, 0x10,
    WRITE_C8_D8, 0xC2, 0x37,
    WRITE_C8_D8, 0xC3, 0x80,
    WRITE_C8_D8, 0xC4, 0x10,
    WRITE_C8_D8, 0xC5, 0x37,
    // Power control
    WRITE_C8_D8, 0xC6, 0xA9,
    WRITE_C8_D8, 0xC7, 0x41,
    WRITE_C8_D8, 0xC8, 0x01,
    WRITE_C8_D8, 0xC9, 0xA9,
    WRITE_C8_D8, 0xCA, 0x41,
    WRITE_C8_D8, 0xCB, 0x01,
    WRITE_C8_D8, 0xCC, 0x7F,
    WRITE_C8_D8, 0xCD, 0x7F,
    WRITE_C8_D8, 0xCE, 0xFF,
    // Resolution
    WRITE_C8_D8, 0xD0, 0x91,
    WRITE_C8_D8, 0xD1, 0x68,
    WRITE_C8_D8, 0xD2, 0x68,
    WRITE_C8_D16, 0xF5, 0x00, 0xA5,
    WRITE_C8_D8, 0xF1, 0x10,
    WRITE_C8_D8, 0xF0, 0x00,

    // Gamma page — FIX: use WRITE_C8_BYTES (sends via 0x02 to correct register)
    WRITE_C8_D8, 0xF0, 0x02,
    WRITE_C8_BYTES, 0xE0, 14,
    0xF0, 0x10, 0x18, 0x0D,
    0x0C, 0x38, 0x3E, 0x44,
    0x51, 0x39, 0x15, 0x15,
    0x30, 0x34,
    WRITE_C8_BYTES, 0xE1, 14,
    0xF0, 0x0F, 0x17, 0x0D,
    0x0B, 0x07, 0x3E, 0x33,
    0x51, 0x39, 0x15, 0x15,
    0x30, 0x34,
    WRITE_C8_D8, 0xF0, 0x10,

    // GIP page
    WRITE_C8_D8, 0xF3, 0x10,
    WRITE_C8_D8, 0xE0, 0x08,
    WRITE_C8_D8, 0xE1, 0x00,
    WRITE_C8_D8, 0xE2, 0x00,
    WRITE_C8_D8, 0xE3, 0x00,
    WRITE_C8_D8, 0xE4, 0xE0,
    WRITE_C8_D8, 0xE5, 0x06,
    WRITE_C8_D8, 0xE6, 0x21,
    WRITE_C8_D8, 0xE7, 0x03,
    WRITE_C8_D8, 0xE8, 0x05,
    WRITE_C8_D8, 0xE9, 0x02,
    WRITE_C8_D8, 0xEA, 0xE9,
    WRITE_C8_D8, 0xEB, 0x00,
    WRITE_C8_D8, 0xEC, 0x00,
    WRITE_C8_D8, 0xED, 0x14,
    WRITE_C8_D8, 0xEE, 0xFF,
    WRITE_C8_D8, 0xEF, 0x00,
    WRITE_C8_D8, 0xF8, 0xFF,
    WRITE_C8_D8, 0xF9, 0x00,
    WRITE_C8_D8, 0xFA, 0x00,
    WRITE_C8_D8, 0xFB, 0x30,
    WRITE_C8_D8, 0xFC, 0x00,
    WRITE_C8_D8, 0xFD, 0x00,
    WRITE_C8_D8, 0xFE, 0x00,
    WRITE_C8_D8, 0xFF, 0x00,
    // Channel config
    WRITE_C8_D8, 0x60, 0x40,
    WRITE_C8_D8, 0x61, 0x05,
    WRITE_C8_D8, 0x62, 0x00,
    WRITE_C8_D8, 0x63, 0x42,
    WRITE_C8_D8, 0x64, 0xDA,
    WRITE_C8_D8, 0x65, 0x00,
    WRITE_C8_D8, 0x66, 0x00,
    WRITE_C8_D8, 0x67, 0x00,
    WRITE_C8_D8, 0x68, 0x00,
    WRITE_C8_D8, 0x69, 0x00,
    WRITE_C8_D8, 0x6A, 0x00,
    WRITE_C8_D8, 0x6B, 0x00,
    WRITE_C8_D8, 0x70, 0x40,
    WRITE_C8_D8, 0x71, 0x04,
    WRITE_C8_D8, 0x72, 0x00,
    WRITE_C8_D8, 0x73, 0x42,
    WRITE_C8_D8, 0x74, 0xD9,
    WRITE_C8_D8, 0x75, 0x00,
    WRITE_C8_D8, 0x76, 0x00,
    WRITE_C8_D8, 0x77, 0x00,
    WRITE_C8_D8, 0x78, 0x00,
    WRITE_C8_D8, 0x79, 0x00,
    WRITE_C8_D8, 0x7A, 0x00,
    WRITE_C8_D8, 0x7B, 0x00,
    // Gate driver mapping
    WRITE_C8_D8, 0x80, 0x48,
    WRITE_C8_D8, 0x81, 0x00,
    WRITE_C8_D8, 0x82, 0x07,
    WRITE_C8_D8, 0x83, 0x02,
    WRITE_C8_D8, 0x84, 0xD7,
    WRITE_C8_D8, 0x85, 0x04,
    WRITE_C8_D8, 0x86, 0x00,
    WRITE_C8_D8, 0x87, 0x00,
    WRITE_C8_D8, 0x88, 0x48,
    WRITE_C8_D8, 0x89, 0x00,
    WRITE_C8_D8, 0x8A, 0x09,
    WRITE_C8_D8, 0x8B, 0x02,
    WRITE_C8_D8, 0x8C, 0xD9,
    WRITE_C8_D8, 0x8D, 0x04,
    WRITE_C8_D8, 0x8E, 0x00,
    WRITE_C8_D8, 0x8F, 0x00,
    WRITE_C8_D8, 0x90, 0x48,
    WRITE_C8_D8, 0x91, 0x00,
    WRITE_C8_D8, 0x92, 0x0B,
    WRITE_C8_D8, 0x93, 0x02,
    WRITE_C8_D8, 0x94, 0xDB,
    WRITE_C8_D8, 0x95, 0x04,
    WRITE_C8_D8, 0x96, 0x00,
    WRITE_C8_D8, 0x97, 0x00,
    WRITE_C8_D8, 0x98, 0x48,
    WRITE_C8_D8, 0x99, 0x00,
    WRITE_C8_D8, 0x9A, 0x0D,
    WRITE_C8_D8, 0x9B, 0x02,
    WRITE_C8_D8, 0x9C, 0xDD,
    WRITE_C8_D8, 0x9D, 0x04,
    WRITE_C8_D8, 0x9E, 0x00,
    WRITE_C8_D8, 0x9F, 0x00,
    WRITE_C8_D8, 0xA0, 0x48,
    WRITE_C8_D8, 0xA1, 0x00,
    WRITE_C8_D8, 0xA2, 0x06,
    WRITE_C8_D8, 0xA3, 0x02,
    WRITE_C8_D8, 0xA4, 0xD6,
    WRITE_C8_D8, 0xA5, 0x04,
    WRITE_C8_D8, 0xA6, 0x00,
    WRITE_C8_D8, 0xA7, 0x00,
    WRITE_C8_D8, 0xA8, 0x48,
    WRITE_C8_D8, 0xA9, 0x00,
    WRITE_C8_D8, 0xAA, 0x08,
    WRITE_C8_D8, 0xAB, 0x02,
    WRITE_C8_D8, 0xAC, 0xD8,
    WRITE_C8_D8, 0xAD, 0x04,
    WRITE_C8_D8, 0xAE, 0x00,
    WRITE_C8_D8, 0xAF, 0x00,
    WRITE_C8_D8, 0xB0, 0x48,
    WRITE_C8_D8, 0xB1, 0x00,
    WRITE_C8_D8, 0xB2, 0x0A,
    WRITE_C8_D8, 0xB3, 0x02,
    WRITE_C8_D8, 0xB4, 0xDA,
    WRITE_C8_D8, 0xB5, 0x04,
    WRITE_C8_D8, 0xB6, 0x00,
    WRITE_C8_D8, 0xB7, 0x00,
    WRITE_C8_D8, 0xB8, 0x48,
    WRITE_C8_D8, 0xB9, 0x00,
    WRITE_C8_D8, 0xBA, 0x0C,
    WRITE_C8_D8, 0xBB, 0x02,
    WRITE_C8_D8, 0xBC, 0xDC,
    WRITE_C8_D8, 0xBD, 0x04,
    WRITE_C8_D8, 0xBE, 0x00,
    WRITE_C8_D8, 0xBF, 0x00,
    // Gate mapping
    WRITE_C8_D8, 0xC0, 0x10,
    WRITE_C8_D8, 0xC1, 0x47,
    WRITE_C8_D8, 0xC2, 0x56,
    WRITE_C8_D8, 0xC3, 0x65,
    WRITE_C8_D8, 0xC4, 0x74,
    WRITE_C8_D8, 0xC5, 0x88,
    WRITE_C8_D8, 0xC6, 0x99,
    WRITE_C8_D8, 0xC7, 0x01,
    WRITE_C8_D8, 0xC8, 0xBB,
    WRITE_C8_D8, 0xC9, 0xAA,
    WRITE_C8_D8, 0xD0, 0x10,
    WRITE_C8_D8, 0xD1, 0x47,
    WRITE_C8_D8, 0xD2, 0x56,
    WRITE_C8_D8, 0xD3, 0x65,
    WRITE_C8_D8, 0xD4, 0x74,
    WRITE_C8_D8, 0xD5, 0x88,
    WRITE_C8_D8, 0xD6, 0x99,
    WRITE_C8_D8, 0xD7, 0x01,
    WRITE_C8_D8, 0xD8, 0xBB,
    WRITE_C8_D8, 0xD9, 0xAA,
    // Exit GIP
    WRITE_C8_D8, 0xF3, 0x01,
    WRITE_C8_D8, 0xF0, 0x00,

    // OTP calibration (from 180 init — factory trim for this panel)
    WRITE_C8_D8, 0xF0, 0x01,
    WRITE_C8_D8, 0xF1, 0x01,
    WRITE_C8_D8, 0xA0, 0x0B,
    WRITE_C8_D8, 0xA3, 0x2A,
    WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x2B,
    WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x2C,
    WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x2D,
    WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x2E,
    WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x2F,
    WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x30,
    WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x31,
    WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x32,
    WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x33,
    WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA0, 0x09,
    WRITE_C8_D8, 0xF1, 0x10,
    WRITE_C8_D8, 0xF0, 0x00,

    // CASET/RASET + RAM clear (from 180 init)
    WRITE_C8_BYTES, 0x2A, 4, 0x00, 0x00, 0x01, 0x67,
    WRITE_C8_BYTES, 0x2B, 4, 0x01, 0x68, 0x01, 0x68,
    WRITE_C8_D8, 0x4D, 0x00,
    WRITE_C8_D8, 0x4E, 0x00,
    WRITE_C8_D8, 0x4F, 0x00,
    WRITE_C8_D8, 0x4C, 0x01,
    END_WRITE, DELAY, 10, BEGIN_WRITE,
    WRITE_C8_D8, 0x4C, 0x00,
    // Reset CASET/RASET to full range
    WRITE_C8_BYTES, 0x2A, 4, 0x00, 0x00, 0x01, 0x67,
    WRITE_C8_BYTES, 0x2B, 4, 0x00, 0x00, 0x01, 0x67,

    // Display on — COLMOD 0x55, no TEON
    WRITE_C8_D8, 0x3A, 0x55,    // COLMOD RGB565
    WRITE_COMMAND_8, 0x21,       // INVON
    WRITE_COMMAND_8, 0x11,       // SLPOUT
    END_WRITE,

    DELAY, 120,

    BEGIN_WRITE,
    WRITE_COMMAND_8, 0x29,       // DISPON
    WRITE_COMMAND_8, 0x2C,       // RAMWR
    END_WRITE,
};

Arduino_DataBus *bus = new Arduino_ESP32QSPI(
    PIN_CS, PIN_CLK, PIN_D0, PIN_D1, PIN_D2, PIN_D3
);

Arduino_GFX *gfx = new Arduino_ST77916(
    bus, PIN_RST, 0 /* rotation */, true /* IPS */,
    ST77916_TFTWIDTH, ST77916_TFTHEIGHT,
    0, 0, 0, 0,
    st77916_custom_init, sizeof(st77916_custom_init)
);

void setup() {
    Serial.begin(115200);
    delay(2000);
    Serial.println("\n[QSPI] Custom init: 150 base + COLMOD 0x55 + gamma C8_BYTES fix");
    Serial.printf("  ESP-IDF: %s\n", esp_get_idf_version());

    pinMode(PIN_BL, OUTPUT);
    digitalWrite(PIN_BL, HIGH);

    Serial.println("[INIT] gfx->begin(40MHz)...");
    gfx->begin(40000000);
    Serial.println("[OK] Init complete");

    Serial.println("[TEST 1] RED...");
    gfx->fillScreen(RGB565_RED);
    delay(3000);

    Serial.println("[TEST 2] GREEN...");
    gfx->fillScreen(RGB565_GREEN);
    delay(3000);

    Serial.println("[TEST 3] BLUE...");
    gfx->fillScreen(RGB565_BLUE);
    delay(3000);

    Serial.println("[TEST 4] WHITE...");
    gfx->fillScreen(RGB565_WHITE);
    delay(3000);

    Serial.println("[TEST 5] Shapes...");
    gfx->fillScreen(RGB565_BLACK);
    gfx->fillCircle(180, 180, 150, RGB565_RED);
    gfx->fillCircle(180, 180, 100, RGB565_GREEN);
    gfx->fillCircle(180, 180, 50, RGB565_BLUE);
    gfx->drawRect(30, 30, 300, 300, RGB565_WHITE);
    delay(5000);

    // TEST 6: Terrarium-like mixed color scene (real-world content test)
    Serial.println("[TEST 6] Terrarium scene...");
    gfx->fillScreen(RGB565(8, 12, 32));   // Deep navy background
    // Water gradient
    for (int y = 0; y < 360; y++) {
        uint8_t b = 40 + (y * 80 / 360);
        uint8_t g = 20 + (y * 40 / 360);
        gfx->drawFastHLine(0, y, 360, RGB565(0, g, b));
    }
    // Sand at bottom
    gfx->fillRect(0, 300, 360, 60, RGB565(200, 180, 120));
    // Seaweed
    for (int x = 40; x < 360; x += 80) {
        for (int y = 200; y < 310; y += 3) {
            int dx = (y % 12 < 6) ? 3 : -3;
            gfx->fillRect(x + dx, y, 6, 3, RGB565(20, 100, 40));
        }
    }
    // Octopus body (terracotta)
    gfx->fillCircle(180, 160, 35, RGB565(192, 112, 88));
    // Eyes
    gfx->fillCircle(168, 152, 6, RGB565_WHITE);
    gfx->fillCircle(192, 152, 6, RGB565_WHITE);
    gfx->fillCircle(170, 152, 3, RGB565_BLACK);
    gfx->fillCircle(194, 152, 3, RGB565_BLACK);
    // Tentacles
    for (int i = -3; i <= 3; i++) {
        gfx->drawLine(180 + i*12, 190, 180 + i*18, 240, RGB565(176, 96, 72));
    }
    // HUD text area (semi-transparent panel feel)
    gfx->fillRect(10, 10, 160, 50, RGB565(15, 23, 42));
    gfx->drawRect(10, 10, 160, 50, RGB565(100, 116, 139));
    gfx->setCursor(16, 24);
    gfx->setTextColor(RGB565(148, 163, 184));
    gfx->setTextSize(2);
    gfx->print("AgentDeck");

    Serial.println("[DONE] Terrarium scene rendered.");
}

void loop() {
    delay(10000);
}
