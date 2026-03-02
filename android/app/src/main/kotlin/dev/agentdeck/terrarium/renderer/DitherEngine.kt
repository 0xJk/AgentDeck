package dev.agentdeck.terrarium.renderer

import android.graphics.Bitmap
import android.graphics.Color

/**
 * Floyd-Steinberg dithering engine — converts ARGB bitmap to quantized grayscale.
 * Error diffusion weights: 7/16, 3/16, 5/16, 1/16.
 *
 * All methods use bulk getPixels/setPixels to minimize JNI overhead
 * (2 calls vs 2×W×H per-pixel calls on a 600×300 bitmap).
 */
object DitherEngine {

    /** Extract luminance from bulk pixel array into float buffer. */
    private fun extractLuminance(pixels: IntArray, lum: FloatArray) {
        for (i in pixels.indices) {
            val pixel = pixels[i]
            lum[i] = 0.299f * Color.red(pixel) + 0.587f * Color.green(pixel) + 0.114f * Color.blue(pixel)
        }
    }

    /** Write gray values from float buffer back to pixel array (opaque gray). */
    private fun writeLuminance(pixels: IntArray, lum: FloatArray, binarize: Boolean = false) {
        for (i in pixels.indices) {
            val v = if (binarize) {
                if (lum[i] > 127.5f) 255 else 0
            } else {
                lum[i].toInt().coerceIn(0, 255)
            }
            pixels[i] = (0xFF shl 24) or (v shl 16) or (v shl 8) or v
        }
    }

    /**
     * Quantize to N gray levels with Floyd-Steinberg error diffusion.
     * Input: ARGB_8888 bitmap. Output: same bitmap with [levels] distinct gray values.
     * E.g. levels=16 → values 0, 17, 34, …, 255.
     */
    fun quantizeGray(bitmap: Bitmap, levels: Int = 16) {
        val w = bitmap.width
        val h = bitmap.height
        val pixels = IntArray(w * h)
        bitmap.getPixels(pixels, 0, w, 0, 0, w, h)

        val step = 255f / (levels - 1)
        val lum = FloatArray(w * h)
        extractLuminance(pixels, lum)

        for (y in 0 until h) {
            for (x in 0 until w) {
                val idx = y * w + x
                val oldVal = lum[idx]
                val newVal = (Math.round(oldVal / step) * step).coerceIn(0f, 255f)
                lum[idx] = newVal

                val error = oldVal - newVal
                if (x + 1 < w)
                    lum[idx + 1] += error * 7f / 16f
                if (y + 1 < h) {
                    if (x - 1 >= 0)
                        lum[(y + 1) * w + x - 1] += error * 3f / 16f
                    lum[(y + 1) * w + x] += error * 5f / 16f
                    if (x + 1 < w)
                        lum[(y + 1) * w + x + 1] += error * 1f / 16f
                }
            }
        }

        writeLuminance(pixels, lum)
        bitmap.setPixels(pixels, 0, w, 0, 0, w, h)
    }

    /**
     * Apply Floyd-Steinberg dithering in-place (1-bit, pure black/white).
     */
    fun floydSteinberg(bitmap: Bitmap) {
        val w = bitmap.width
        val h = bitmap.height
        val pixels = IntArray(w * h)
        bitmap.getPixels(pixels, 0, w, 0, 0, w, h)

        val lum = FloatArray(w * h)
        extractLuminance(pixels, lum)

        for (y in 0 until h) {
            for (x in 0 until w) {
                val idx = y * w + x
                val oldVal = lum[idx]
                val newVal = if (oldVal > 127.5f) 255f else 0f
                lum[idx] = newVal

                val error = oldVal - newVal
                if (x + 1 < w)
                    lum[idx + 1] += error * 7f / 16f
                if (y + 1 < h) {
                    if (x - 1 >= 0)
                        lum[(y + 1) * w + x - 1] += error * 3f / 16f
                    lum[(y + 1) * w + x] += error * 5f / 16f
                    if (x + 1 < w)
                        lum[(y + 1) * w + x + 1] += error * 1f / 16f
                }
            }
        }

        writeLuminance(pixels, lum, binarize = true)
        bitmap.setPixels(pixels, 0, w, 0, 0, w, h)
    }

    /**
     * Snap each pixel to the nearest N-level gray without error diffusion.
     * E-ink hardware with native grayscale support renders these levels directly,
     * so dithering dot patterns are unnecessary and counterproductive.
     */
    fun snapToNearestGray(bitmap: Bitmap, levels: Int = 16) {
        val w = bitmap.width
        val h = bitmap.height
        val pixels = IntArray(w * h)
        bitmap.getPixels(pixels, 0, w, 0, 0, w, h)

        val step = 255f / (levels - 1)
        for (i in pixels.indices) {
            val pixel = pixels[i]
            val lum = 0.299f * Color.red(pixel) + 0.587f * Color.green(pixel) + 0.114f * Color.blue(pixel)
            val snapped = (Math.round(lum / step) * step).toInt().coerceIn(0, 255)
            pixels[i] = (0xFF shl 24) or (snapped shl 16) or (snapped shl 8) or snapped
        }
        bitmap.setPixels(pixels, 0, w, 0, 0, w, h)
    }

    /**
     * Apply dithering with adjustable threshold for dissolve effects.
     * [threshold] 0.0 = normal dither, 1.0 = all white (dissolved).
     */
    fun floydSteinbergWithThreshold(bitmap: Bitmap, threshold: Float) {
        val adjustedThreshold = 127.5f + threshold * 127.5f

        val w = bitmap.width
        val h = bitmap.height
        val pixels = IntArray(w * h)
        bitmap.getPixels(pixels, 0, w, 0, 0, w, h)

        val lum = FloatArray(w * h)
        extractLuminance(pixels, lum)

        for (y in 0 until h) {
            for (x in 0 until w) {
                val idx = y * w + x
                val oldVal = lum[idx]
                val newVal = if (oldVal > adjustedThreshold) 255f else 0f
                lum[idx] = newVal

                val error = oldVal - newVal
                if (x + 1 < w)
                    lum[idx + 1] += error * 7f / 16f
                if (y + 1 < h) {
                    if (x - 1 >= 0)
                        lum[(y + 1) * w + x - 1] += error * 3f / 16f
                    lum[(y + 1) * w + x] += error * 5f / 16f
                    if (x + 1 < w)
                        lum[(y + 1) * w + x + 1] += error * 1f / 16f
                }
            }
        }

        writeLuminance(pixels, lum, binarize = true)
        bitmap.setPixels(pixels, 0, w, 0, 0, w, h)
    }
}
