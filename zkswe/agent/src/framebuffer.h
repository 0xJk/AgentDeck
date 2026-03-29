#pragma once
#include <stdint.h>

typedef struct { uint8_t b, g, r, a; } Color;

#define COLOR(R,G,B) ((Color){(B),(G),(R),255})

int   fb_init(void);
void  fb_close(void);
void  fb_clear(Color c);
void  fb_set_pixel(int sx, int sy, Color c);
void  fb_fill_rect(int x1, int y1, int x2, int y2, Color c);
void  fb_draw_text(int x, int y, const char *text, int scale, Color c);
void  fb_draw_text_centered(int cx, int cy, const char *text, int scale, Color c);
void  fb_draw_gauge(int x, int y, int w, int h, int percent, Color bar, Color bg);
void  fb_set_backlight(int brightness);
