/**
 * Wake Word Detection — I2S PDM Microphone on ESP32-S3
 *
 * Uses new ESP-IDF 5.x I2S PDM RX API (driver/i2s_pdm.h).
 * Old legacy API (driver/i2s.h) is deprecated and fails silently on ESP-IDF 5.x.
 */

#include "wake_word.h"

#ifdef BOARD_HAS_AUDIO

#include <Arduino.h>
#include <driver/i2s_pdm.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include "../../boards/board_round_amoled.h"

namespace Audio {

static constexpr int SAMPLE_RATE       = 16000;
static constexpr int FRAME_SAMPLES     = 480;    // 30ms at 16kHz
static constexpr int FRAME_BYTES       = FRAME_SAMPLES * sizeof(int16_t);
static constexpr float VAD_THRESHOLD   = 200.0f;
static constexpr int   VAD_HOLD_FRAMES = 30;

static volatile bool g_detected = false;
static volatile bool g_running = false;
static TaskHandle_t taskHandle = nullptr;
static volatile float g_rmsLevel = 0;
static volatile bool g_speechActive = false;
static volatile const char* g_status = "off";

static i2s_chan_handle_t rx_handle = nullptr;

// ===== I2S PDM RX Setup (ESP-IDF 5.x new API) =====
static bool initI2S() {
    // Channel config
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    chan_cfg.dma_desc_num = 4;
    chan_cfg.dma_frame_num = FRAME_SAMPLES;

    esp_err_t err = i2s_new_channel(&chan_cfg, NULL, &rx_handle);
    if (err != ESP_OK) {
        g_status = "err:chan";
        return false;
    }

    // PDM RX config
    i2s_pdm_rx_config_t pdm_cfg = {
        .clk_cfg = I2S_PDM_RX_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
        .slot_cfg = I2S_PDM_RX_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .clk = (gpio_num_t)BOARD_PIN_I2S_LRCLK,
            .din = (gpio_num_t)BOARD_PIN_I2S_DIN,
            .invert_flags = {
                .clk_inv = false,
            },
        },
    };

    err = i2s_channel_init_pdm_rx_mode(rx_handle, &pdm_cfg);
    if (err != ESP_OK) {
        g_status = "err:pdm";
        i2s_del_channel(rx_handle);
        rx_handle = nullptr;
        return false;
    }

    err = i2s_channel_enable(rx_handle);
    if (err != ESP_OK) {
        g_status = "err:en";
        i2s_del_channel(rx_handle);
        rx_handle = nullptr;
        return false;
    }

    g_status = "init";
    return true;
}

static float calcRMS(const int16_t* samples, int count) {
    int64_t sum = 0;
    for (int i = 0; i < count; i++) {
        int32_t s = samples[i];
        sum += s * s;
    }
    return sqrtf((float)sum / count);
}

// ===== Microphone Task =====
static void micTask(void* param) {
    g_running = true;

    int16_t* buffer = (int16_t*)ps_malloc(FRAME_BYTES);
    if (!buffer) {
        g_status = "err:mem";
        g_running = false;
        vTaskDelete(NULL);
        return;
    }

    // Warm up
    g_status = "warmup";
    int warmupOk = 0;
    for (int i = 0; i < 10; i++) {
        size_t bytes_read = 0;
        esp_err_t err = i2s_channel_read(rx_handle, buffer, FRAME_BYTES, &bytes_read, pdMS_TO_TICKS(500));
        if (err == ESP_OK && bytes_read > 0) warmupOk++;
    }
    g_status = warmupOk > 0 ? "listening" : "err:warmup";

    if (warmupOk == 0) {
        free(buffer);
        g_running = false;
        vTaskDelete(NULL);
        return;
    }

    int vadHoldCounter = 0;

    while (g_running) {
        size_t bytes_read = 0;
        esp_err_t err = i2s_channel_read(rx_handle, buffer, FRAME_BYTES,
                                          &bytes_read, pdMS_TO_TICKS(500));

        if (err != ESP_OK || bytes_read == 0) {
            g_status = "err:read";
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        g_status = "listening";

        float rms = calcRMS(buffer, FRAME_SAMPLES);
        g_rmsLevel = rms;

        bool isSpeech = (rms > VAD_THRESHOLD);
        if (isSpeech) {
            vadHoldCounter = VAD_HOLD_FRAMES;
        } else if (vadHoldCounter > 0) {
            vadHoldCounter--;
            isSpeech = true;
        }

        g_speechActive = isSpeech;
    }

    free(buffer);
    if (rx_handle) {
        i2s_channel_disable(rx_handle);
        i2s_del_channel(rx_handle);
        rx_handle = nullptr;
    }
    g_status = "off";
    taskHandle = nullptr;
    vTaskDelete(NULL);
}

// ===== Public API =====

bool wakeWordInit() {
    return initI2S();
}

void wakeWordStart() {
    if (taskHandle) return;
    xTaskCreatePinnedToCore(micTask, "mic", 4096, NULL, 1, &taskHandle, 0);
}

void wakeWordStop() {
    g_running = false;
}

bool wakeWordDetected() {
    if (g_detected) {
        g_detected = false;
        return true;
    }
    return false;
}

bool wakeWordRunning() {
    return g_running;
}

float wakeWordMicLevel() {
    return g_rmsLevel;
}

const char* wakeWordStatus() {
    return (const char*)g_status;
}

}  // namespace Audio

#else
namespace Audio {
bool wakeWordInit()         { return false; }
void wakeWordStart()        {}
void wakeWordStop()         {}
bool wakeWordDetected()     { return false; }
bool wakeWordRunning()      { return false; }
float wakeWordMicLevel()    { return 0; }
const char* wakeWordStatus(){ return "off"; }
}
#endif
