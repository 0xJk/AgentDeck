#define _POSIX_C_SOURCE 200112L
#include "buttons.h"
#include <signal.h>
#include <stdio.h>
#include <time.h>

static volatile int running = 1;

static void on_signal(int sig) {
    (void)sig;
    running = 0;
}

static void on_press(ButtonId id) {
    printf("BUTTON %d\n", (int)id);
    fflush(stdout);
}

int main(void) {
    struct timespec ts;

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    if (buttons_init() != 0) {
        fprintf(stderr, "button_test: init failed\n");
        return 1;
    }

    printf("button_test: ready\n");
    fflush(stdout);

    ts.tv_sec = 0;
    ts.tv_nsec = 20 * 1000 * 1000L;
    while (running) {
        buttons_process(on_press);
        nanosleep(&ts, NULL);
    }

    buttons_close();
    return 0;
}
