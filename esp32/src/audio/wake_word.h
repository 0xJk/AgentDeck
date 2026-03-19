#pragma once

/**
 * Wake Word Detection — microWakeWord on ESP32-S3
 *
 * Uses I2S PDM microphone on Round AMOLED board (GPIO45 LRCLK, GPIO46 DIN)
 * and TFLite Micro streaming inference for "오픈클로" keyword detection.
 *
 * Architecture:
 *   - Dedicated FreeRTOS task on Core 0
 *   - I2S → 16kHz PCM → spectrogram features → TFLite inference
 *   - Detection fires callback (thread-safe via queue)
 */

#include <cstdint>

namespace Audio {

/**
 * Initialize wake word detection.
 * Allocates I2S driver, TFLite interpreter, and feature buffers.
 * Returns false if hardware not available (non-Round AMOLED boards).
 */
bool wakeWordInit();

/**
 * Start the wake word detection task (FreeRTOS).
 * Begins continuous microphone capture and inference.
 */
void wakeWordStart();

/**
 * Stop detection (e.g., during voice recording to avoid feedback).
 */
void wakeWordStop();

/**
 * Check if a wake word was detected since last call.
 * Thread-safe — can be called from any task.
 * Returns true once per detection (auto-resets).
 */
bool wakeWordDetected();

/**
 * Check if wake word detection is running.
 */
bool wakeWordRunning();

/**
 * Get current mic RMS level (0 = silence). Thread-safe.
 */
float wakeWordMicLevel();

/**
 * Get mic status string for diagnostics.
 * Returns: "off", "init", "warmup", "listening", "error"
 */
const char* wakeWordStatus();

}  // namespace Audio
