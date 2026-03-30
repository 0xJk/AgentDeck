#pragma once

/* Button IDs matching the manifest0.json layout:
 * 5 rows × 4 cols (0_0 through 4_3), with key 4_2 merged into 4_3.
 * Our dashboard maps these 18 logical keys to 14 UI slots. */
typedef enum {
    BTN_MODE = 0,    /* manifest 0_0 */
    BTN_SESSION,     /* manifest 0_1 */
    BTN_USAGE,       /* manifest 0_2 */
    BTN_QA1,         /* manifest 0_3 */
    BTN_QA2,         /* manifest 1_0 */
    BTN_QA3,         /* manifest 1_1 */
    BTN_QA4,         /* manifest 1_2 */
    BTN_MODEL,       /* manifest 1_3 */
    BTN_5H,          /* manifest 2_0 */
    BTN_7D,          /* manifest 2_1 */
    BTN_STOP,        /* manifest 2_2 */
    BTN_TOKENS,      /* manifest 2_3 */
    BTN_COST,        /* manifest 3_0 */
    BTN_INFO,        /* manifest 3_1 - 4_3 (bottom rows) */
    BTN_COUNT
} ButtonId;

typedef void (*button_cb)(ButtonId id);

/* Open /dev/hidg1 for reading MCU button events.
 * Returns 0 on success, -1 on failure (buttons disabled, agent still runs). */
int  buttons_init(void);
void buttons_close(void);

/* Non-blocking: returns the fd for select()/poll(), or -1 if not initialized */
int  buttons_fd(void);

/* Process any pending HID data. Call when buttons_fd() is readable.
 * Calls on_press for each detected button press. */
void buttons_process(button_cb on_press);
