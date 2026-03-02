package dev.agentdeck.ui.deck

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import dev.agentdeck.net.EncoderSlotState

private val LCD_BACKGROUND = Color(0xFF0F172A)
private val DIVIDER_COLOR = Color(0xFF334155)

private val DEFAULT_ENCODERS = listOf(
    EncoderSlotState(slot = 0, encoderType = "utility", header = "UTILITY"),
    EncoderSlotState(slot = 1, encoderType = "action", header = "ACTION"),
    EncoderSlotState(slot = 2, encoderType = "terminal", header = "SESSION"),
    EncoderSlotState(slot = 3, encoderType = "voice", header = "VOICE", voiceState = "idle"),
)

@Composable
fun EncoderStrip(
    encoderStates: List<EncoderSlotState>,
    takeoverActive: Boolean,
    onRotate: (slot: Int, ticks: Int) -> Unit,
    onPush: (slot: Int) -> Unit,
    onLongPress: (slot: Int) -> Unit,
    onRelease: (slot: Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val states = if (encoderStates.isEmpty()) DEFAULT_ENCODERS else encoderStates

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(96.dp)
            .background(LCD_BACKGROUND),
    ) {
        states.forEachIndexed { index, encoderState ->
            if (index > 0) {
                // 1dp divider between panels
                Box(
                    modifier = Modifier
                        .width(1.dp)
                        .height(96.dp)
                        .background(DIVIDER_COLOR),
                )
            }

            EncoderPanel(
                state = encoderState,
                onRotate = { ticks -> onRotate(encoderState.slot, ticks) },
                onPush = { onPush(encoderState.slot) },
                onLongPress = { onLongPress(encoderState.slot) },
                onRelease = { onRelease(encoderState.slot) },
                modifier = Modifier
                    .weight(1f)
                    .height(96.dp),
            )
        }
    }
}
