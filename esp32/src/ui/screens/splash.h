#pragma once

#include <lvgl.h>

namespace Screens {

/**
 * Create splash/connecting screen.
 */
lv_obj_t* splashCreate();

/**
 * Update splash screen status text.
 */
void splashSetStatus(const char* text);

/**
 * Update WiFi provisioning sub-status (shown below main status).
 */
void splashSetWifiStatus(const char* text);

}  // namespace Screens
