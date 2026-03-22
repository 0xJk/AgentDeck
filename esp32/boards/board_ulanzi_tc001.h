#pragma once

// ===== Ulanzi TC001 — 8x32 WS2812B LED Matrix (ESP32 Classic D0WD) =====
// Port: cu.usbserial-211110 (CH340 UART)
// MAC: 24:d7:eb:b1:cd:e4
// Flash: 8MB, No PSRAM

// Display: WS2812B 8x32 addressable LED matrix (256 LEDs, serpentine wiring)
#define BOARD_DISPLAY_TYPE   DISPLAY_WS2812B_MATRIX
#define BOARD_PIN_LED_DATA   32
#define MATRIX_W             32
#define MATRIX_H             8
#define MATRIX_LEDS          256

// Buttons (active LOW, internal pull-up)
#define BOARD_PIN_BTN_LEFT   26
#define BOARD_PIN_BTN_MID    27
#define BOARD_PIN_BTN_RIGHT  14

// Buzzer
#define BOARD_PIN_BUZZER     15

// Sensors
#define BOARD_PIN_LIGHT_SENSOR 35   // ADC1_CH7 — ambient light (LDR)
#define BOARD_PIN_BATTERY      34   // ADC1_CH6 — battery voltage

// RTC: DS1307 via I2C
#define BOARD_PIN_RTC_SDA    21
#define BOARD_PIN_RTC_SCL    22
#define BOARD_RTC_ADDR       0x68

// No touch, no SPI/QSPI display, no backlight PWM
