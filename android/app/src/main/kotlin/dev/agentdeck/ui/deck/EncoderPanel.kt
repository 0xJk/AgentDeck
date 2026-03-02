package dev.agentdeck.ui.deck

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.EncoderSlotState
import kotlin.math.abs

private val LCD_BACKGROUND = Color(0xFF0F172A)
private val HEADER_COLOR = Color(0xFF94A3B8)
private const val DRAG_TICK_DP = 30f

fun parseHexColor(hex: String): Color {
    return try {
        val cleaned = hex.removePrefix("#")
        Color(android.graphics.Color.parseColor("#$cleaned"))
    } catch (_: Exception) {
        HEADER_COLOR
    }
}

@Composable
fun EncoderPanel(
    state: EncoderSlotState,
    onRotate: (ticks: Int) -> Unit,
    onPush: () -> Unit,
    onLongPress: () -> Unit,
    onRelease: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var dragAccumulator by remember { mutableFloatStateOf(0f) }
    val accentColor = parseHexColor(state.accentColor)

    Box(
        modifier = modifier
            .background(LCD_BACKGROUND)
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = { onPush() },
                    onLongPress = { onLongPress() },
                    onPress = {
                        tryAwaitRelease()
                        onRelease()
                    },
                )
            }
            .pointerInput(Unit) {
                detectHorizontalDragGestures(
                    onDragStart = { dragAccumulator = 0f },
                    onHorizontalDrag = { _, dragAmount ->
                        dragAccumulator += dragAmount
                        val ticks = (dragAccumulator / DRAG_TICK_DP).toInt()
                        if (abs(ticks) > 0) {
                            onRotate(ticks)
                            dragAccumulator -= ticks * DRAG_TICK_DP
                        }
                    },
                )
            },
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 4.dp, vertical = 2.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // Counter in top-right
            if (state.counter != null) {
                Box(modifier = Modifier.fillMaxWidth()) {
                    Text(
                        text = state.counter ?: "",
                        fontSize = 9.sp,
                        color = HEADER_COLOR,
                        modifier = Modifier.align(Alignment.TopEnd),
                    )
                }
            }

            // Header
            Text(
                text = state.header,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                color = HEADER_COLOR,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )

            Spacer(modifier = Modifier.weight(1f))

            // Voice-specific rendering
            if (state.encoderType == "voice" && state.voiceState != null) {
                VoiceContent(state)
            } else {
                // Icon + Value center group
                if (state.icon != null) {
                    Text(
                        text = state.icon ?: "",
                        fontSize = 18.sp,
                        textAlign = TextAlign.Center,
                    )
                }
                if (state.value != null) {
                    Text(
                        text = state.value ?: "",
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold,
                        color = Color.White,
                        textAlign = TextAlign.Center,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (state.detail != null) {
                    Text(
                        text = state.detail ?: "",
                        fontSize = 9.sp,
                        color = HEADER_COLOR,
                        textAlign = TextAlign.Center,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            Spacer(modifier = Modifier.weight(1f))

            // Bottom accent bar
            val barProgress = (state.progress ?: 0f).coerceIn(0f, 1f)
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(3.dp)
                    .clip(RoundedCornerShape(1.5.dp)),
            ) {
                // Background track
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(accentColor.copy(alpha = 0.2f)),
                )
                // Filled portion
                if (barProgress > 0f) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(barProgress)
                            .height(3.dp)
                            .background(accentColor),
                    )
                }
            }
        }
    }
}

@Composable
private fun VoiceContent(state: EncoderSlotState) {
    when (state.voiceState) {
        "idle" -> {
            Text(text = "\uD83C\uDF99", fontSize = 18.sp, textAlign = TextAlign.Center)
            Text(
                text = "Ready",
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White,
                textAlign = TextAlign.Center,
            )
        }
        "recording" -> {
            val seconds = ((state.recordingMs ?: 0L) / 1000.0)
            Text(
                text = "\u26AB",
                fontSize = 18.sp,
                color = Color.Red,
                textAlign = TextAlign.Center,
            )
            Text(
                text = "%.1fs".format(seconds),
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White,
                textAlign = TextAlign.Center,
            )
        }
        "transcribing" -> {
            Text(text = "...", fontSize = 18.sp, color = Color.White, textAlign = TextAlign.Center)
            Text(
                text = "Transcribing",
                fontSize = 10.sp,
                color = HEADER_COLOR,
                textAlign = TextAlign.Center,
            )
        }
        "review" -> {
            Text(
                text = state.transcription ?: "",
                fontSize = 10.sp,
                color = Color.White,
                textAlign = TextAlign.Center,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
        "error" -> {
            Text(text = "\u26A0", fontSize = 18.sp, textAlign = TextAlign.Center)
            Text(
                text = state.detail ?: "Error",
                fontSize = 10.sp,
                color = Color(0xFFEF4444),
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
