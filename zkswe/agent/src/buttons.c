/*
 * Button matrix scanner for D200H using sysfs GPIO.
 *
 * Hardware discovery results (2026-03-29):
 * - /dev/hidg1 is NOT MCU→SSD210 input — it's SSD210→host HID output
 * - Buttons use GPIO matrix: outputs {4,5,6,9,85}, inputs {0,1,84}
 * - 5 outputs × 3 inputs = 15 possible combinations → covers 14 physical keys
 * - Input pins have internal pull-ups (read HIGH when idle)
 * - Button press connects output (driven LOW) to input → input reads LOW
 *
 * Matrix layout (5 rows × 3 cols, mapping to dashboard 14-key grid):
 * Will be calibrated by pressing buttons and recording OUT→IN pairs.
 * Initial mapping based on first capture: OUT=85→IN=1, OUT=4→IN=1
 */
#define _DEFAULT_SOURCE
#include "buttons.h"
#include "config.h"
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <time.h>
#include <stdint.h>

#define GPIO_BASE "/sys/class/gpio"

/* Matrix pins — discovered via sysfs_probe on real hardware */
static const int out_pins[] = {4, 5, 6, 9, 85};   /* row drivers */
static const int in_pins[]  = {0, 1, 84};           /* column readers (pulled HIGH) */
#define OUT_COUNT 5
#define IN_COUNT  3
#define MATRIX_SIZE (OUT_COUNT * IN_COUNT) /* 15 */

static int initialized = 0;

/* Debounce state */
static uint16_t prev_stable = 0;
static uint16_t raw_state = 0;
static uint64_t debounce_start = 0;

/*
 * Button mapping table: [out_idx * IN_COUNT + in_idx] → ButtonId
 * Index = out_pin_index * 3 + in_pin_index
 *
 * Calibrated mapping (to be confirmed by physical testing):
 * Each cell is the button pressed when out_pins[row] → in_pins[col]
 *
 *         IN=0(pin0)  IN=1(pin1)  IN=2(pin84)
 * OUT=0(pin4):  BTN_MODE    BTN_SESSION  BTN_USAGE
 * OUT=1(pin5):  BTN_QA1     BTN_QA2      BTN_QA3
 * OUT=2(pin6):  BTN_QA4     BTN_MODEL    BTN_5H
 * OUT=3(pin9):  BTN_7D      BTN_STOP     BTN_TOKENS
 * OUT=4(pin85): BTN_COST    BTN_INFO     BTN_COUNT(none)
 *
 * Note: This is a provisional mapping. The exact row/col→button
 * assignment needs physical calibration pressing each button one by one.
 */
static const ButtonId matrix_map[MATRIX_SIZE] = {
    /* OUT=4(row0):  */ BTN_MODE,    BTN_SESSION, BTN_USAGE,
    /* OUT=5(row1):  */ BTN_QA1,     BTN_QA2,     BTN_QA3,
    /* OUT=6(row2):  */ BTN_QA4,     BTN_MODEL,   BTN_5H,
    /* OUT=9(row3):  */ BTN_7D,      BTN_STOP,    BTN_TOKENS,
    /* OUT=85(row4): */ BTN_COST,    BTN_INFO,    BTN_COUNT,  /* BTN_COUNT = no button */
};

static uint64_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static int gpio_export(int pin) {
    char path[64];
    snprintf(path, sizeof(path), GPIO_BASE "/gpio%d", pin);
    if (access(path, F_OK) == 0) return 0;
    int fd = open(GPIO_BASE "/export", O_WRONLY);
    if (fd < 0) return -1;
    char buf[8];
    int len = snprintf(buf, sizeof(buf), "%d", pin);
    int ret = (write(fd, buf, len) == len) ? 0 : -1;
    close(fd);
    usleep(50000);
    return ret;
}

static int gpio_set_dir(int pin, const char *dir) {
    char path[64];
    snprintf(path, sizeof(path), GPIO_BASE "/gpio%d/direction", pin);
    int fd = open(path, O_WRONLY);
    if (fd < 0) return -1;
    write(fd, dir, strlen(dir));
    close(fd);
    return 0;
}

static void gpio_write_val(int pin_idx, int val) {
    /* Re-open value file each time — sysfs lseek can be unreliable on some kernels */
    char path[64];
    snprintf(path, sizeof(path), GPIO_BASE "/gpio%d/value", out_pins[pin_idx]);
    int fd = open(path, O_WRONLY);
    if (fd < 0) return;
    write(fd, val ? "1" : "0", 1);
    close(fd);
}

static int gpio_read_val(int pin_idx) {
    char path[64];
    snprintf(path, sizeof(path), GPIO_BASE "/gpio%d/value", in_pins[pin_idx]);
    int fd = open(path, O_RDONLY);
    if (fd < 0) return 1; /* assume HIGH (not pressed) on error */
    char buf[4] = {0};
    read(fd, buf, sizeof(buf));
    close(fd);
    return buf[0] == '1' ? 1 : 0;
}

int buttons_init(void) {
    /* Export and configure output pins */
    for (int i = 0; i < OUT_COUNT; i++) {
        if (gpio_export(out_pins[i]) < 0) {
            fprintf(stderr, "buttons: cannot export GPIO %d: %s\n", out_pins[i], strerror(errno));
            return -1;
        }
        gpio_set_dir(out_pins[i], "out");
        gpio_write_val(i, 1); /* HIGH (idle) */
    }

    /* Export and configure input pins */
    for (int i = 0; i < IN_COUNT; i++) {
        if (gpio_export(in_pins[i]) < 0) {
            fprintf(stderr, "buttons: cannot export GPIO %d: %s\n", in_pins[i], strerror(errno));
            return -1;
        }
        gpio_set_dir(in_pins[i], "in");
    }

    initialized = 1;
    printf("buttons: GPIO matrix init OK (%d out × %d in)\n", OUT_COUNT, IN_COUNT);
    return 0;
}

void buttons_close(void) {
    initialized = 0;
}

int buttons_fd(void) {
    return -1; /* sysfs GPIO doesn't support select/poll for value changes */
}

static int scan_count = 0;

void buttons_process(button_cb on_press) {
    if (!initialized || !on_press) return;

    scan_count++;
    if (scan_count % 500 == 1) { /* log every 500 scans (~10 sec) */
        printf("buttons: scan #%d (in0=%d in1=%d in2=%d)\n",
               scan_count, gpio_read_val(0), gpio_read_val(1), gpio_read_val(2));
    }

    uint16_t pressed = 0;

    for (int row = 0; row < OUT_COUNT; row++) {
        /* Drive this row LOW */
        gpio_write_val(row, 0);
        usleep(100); /* settle */

        /* Read all columns */
        for (int col = 0; col < IN_COUNT; col++) {
            int val = gpio_read_val(col);
            if (val == 0) {
                /* LOW = button pressed (input is normally HIGH) */
                int idx = row * IN_COUNT + col;
                ButtonId btn = matrix_map[idx];
                printf("buttons: MATRIX HIT out=%d(pin%d) in=%d(pin%d) → btn=%d\n",
                       row, out_pins[row], col, in_pins[col], (int)btn);
                if (btn < BTN_COUNT) {
                    pressed |= (1 << btn);
                }
            }
        }

        /* Restore row HIGH */
        gpio_write_val(row, 1);
    }

    /* Debounce */
    if (pressed != raw_state) {
        raw_state = pressed;
        debounce_start = now_ms();
        return;
    }
    if (pressed == prev_stable) return;
    if (now_ms() - debounce_start < DEBOUNCE_MS) return;

    /* Detect newly pressed */
    uint16_t newly = pressed & ~prev_stable;
    prev_stable = pressed;

    for (int i = 0; i < BTN_COUNT && newly; i++) {
        if (newly & (1 << i)) {
            printf("buttons: BTN_%d pressed\n", i);
            on_press((ButtonId)i);
        }
    }
}
