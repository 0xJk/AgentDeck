// Standalone AXS15231B QSPI test — exact match of Arduino_GFX JC3248W535 preset
// Board: JC3248W535 (3.5" IPS 320×480)
// This test uses Arduino_Canvas wrapper like the official preset

#include <Arduino.h>
#include <Arduino_GFX_Library.h>

// JC3248W535 pin map (from board_35_ips.h)
#define PIN_CS    45
#define PIN_CLK   47
#define PIN_D0    21
#define PIN_D1    48
#define PIN_D2    40
#define PIN_D3    39
#define PIN_BL     1

// Exact copy of Arduino_GFX JC3248W535 preset (Arduino_GFX_dev_device.h:527-538)
Arduino_DataBus *bus = new Arduino_ESP32QSPI(
    PIN_CS, PIN_CLK, PIN_D0, PIN_D1, PIN_D2, PIN_D3);

Arduino_GFX *g = new Arduino_AXS15231B(
    bus, GFX_NOT_DEFINED /* RST */, 0 /* rotation */, false /* IPS */, 320, 480,
    0 /* col offset 1 */, 0 /* row offset 1 */, 0 /* col offset 2 */, 0 /* row offset 2 */,
    axs15231b_320480_type1_init_operations, sizeof(axs15231b_320480_type1_init_operations));

// Canvas wrapper — JC3248W535 preset uses this
Arduino_Canvas *gfx = new Arduino_Canvas(
    320 /* width */, 480 /* height */, g, 0 /* output_x */, 0 /* output_y */, 0 /* rotation */);

void setup() {
    Serial.begin(115200);
    delay(3000);  // USB CDC Serial enumerate
    Serial.println("\n========================================");
    Serial.println("[AXS15231B TEST] JC3248W535 QSPI preset");
    Serial.printf("  ESP-IDF: %s\n", esp_get_idf_version());
    Serial.println("  Pins: CS=45 CLK=47 D0=21 D1=48 D2=40 D3=39");
    Serial.println("  Init: axs15231b_320480_type1 + Canvas wrapper");
    Serial.println("========================================\n");

    // Backlight ON
    pinMode(PIN_BL, OUTPUT);
    digitalWrite(PIN_BL, HIGH);
    Serial.println("[BL] Backlight ON (pin 1 HIGH)");
    delay(200);

    // Init display
    Serial.println("[INIT] gfx->begin()...");
    bool ok = gfx->begin();
    Serial.printf("[INIT] Result: %s\n", ok ? "OK" : "FAILED");

    if (!ok) {
        Serial.println("[INIT] Retrying with explicit 16MHz...");
        ok = gfx->begin(16000000);
        Serial.printf("[INIT] Retry result: %s\n", ok ? "OK" : "FAILED");
    }

    // Test 1: RED fill + flush
    Serial.println("[TEST 1] RED fill...");
    gfx->fillScreen(RGB565_RED);
    gfx->flush();
    Serial.println("[TEST 1] Flushed. Wait 3s...");
    delay(3000);

    // Test 2: GREEN fill + flush
    Serial.println("[TEST 2] GREEN fill...");
    gfx->fillScreen(RGB565_GREEN);
    gfx->flush();
    Serial.println("[TEST 2] Flushed. Wait 3s...");
    delay(3000);

    // Test 3: BLUE fill + flush
    Serial.println("[TEST 3] BLUE fill...");
    gfx->fillScreen(RGB565_BLUE);
    gfx->flush();
    Serial.println("[TEST 3] Flushed. Wait 3s...");
    delay(3000);

    // Test 4: WHITE fill + flush
    Serial.println("[TEST 4] WHITE fill...");
    gfx->fillScreen(RGB565_WHITE);
    gfx->flush();
    Serial.println("[TEST 4] Flushed. Wait 3s...");
    delay(3000);

    // Test 5: Direct draw to underlying display (bypass Canvas)
    Serial.println("[TEST 5] Direct draw to 'g' (no Canvas)...");
    g->fillScreen(RGB565_RED);
    Serial.println("[TEST 5] Direct RED fill done. Wait 3s...");
    delay(3000);

    // Test 6: Rotation test
    Serial.println("[TEST 6] Rotation=1 (landscape) + shapes...");
    gfx->setRotation(1);  // 480x320 landscape
    gfx->fillScreen(RGB565_BLACK);
    gfx->fillCircle(240, 160, 100, RGB565_RED);
    gfx->fillCircle(240, 160, 60, RGB565_GREEN);
    gfx->fillCircle(240, 160, 30, RGB565_BLUE);
    gfx->setCursor(20, 20);
    gfx->setTextColor(RGB565_WHITE);
    gfx->setTextSize(3);
    gfx->print("JC3248W535");
    gfx->flush();
    Serial.println("[TEST 6] Flushed.");

    // Test 7: Try backlight LOW then HIGH (verify BL pin polarity)
    Serial.println("[TEST 7] BL polarity test: OFF for 2s...");
    digitalWrite(PIN_BL, LOW);
    delay(2000);
    Serial.println("[TEST 7] BL back ON...");
    digitalWrite(PIN_BL, HIGH);
    delay(1000);

    Serial.println("\n[DONE] All tests complete. Display should show concentric circles.");
    Serial.println("If screen is BLACK: check QSPI wiring, try type2 init, or lower clock.");
}

void loop() {
    delay(10000);
}
