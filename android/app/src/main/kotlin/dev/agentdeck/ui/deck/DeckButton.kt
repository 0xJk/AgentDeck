package dev.agentdeck.ui.deck

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun DeckButton(
    config: DeckButtonConfig,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var pressed by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.95f else 1f,
        animationSpec = tween(durationMillis = 80),
        label = "press_scale",
    )
    val alpha by animateFloatAsState(
        targetValue = if (pressed) 0.85f else 1f,
        animationSpec = tween(durationMillis = 80),
        label = "press_alpha",
    )

    Box(
        modifier = modifier
            .scale(scale)
            .graphicsLayer { this.alpha = alpha }
            .clip(RoundedCornerShape(12.dp))
            .background(config.bgColor)
            .then(
                if (config.enabled) {
                    Modifier.pointerInput(Unit) {
                        detectTapGestures(
                            onPress = {
                                pressed = true
                                tryAwaitRelease()
                                pressed = false
                            },
                            onTap = { onClick() },
                        )
                    }
                } else {
                    Modifier
                }
            )
            .padding(6.dp),
        contentAlignment = Alignment.Center,
    ) {
        // Badge in top-right corner
        if (config.badge != null) {
            Text(
                text = config.badge,
                fontSize = 9.sp,
                color = config.textColor.copy(alpha = 0.6f),
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(2.dp),
            )
        }

        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier.fillMaxSize(),
        ) {
            // Icon above title
            if (config.icon != null) {
                Text(
                    text = config.icon,
                    fontSize = 18.sp,
                    textAlign = TextAlign.Center,
                )
            }
            Text(
                text = config.title,
                style = MaterialTheme.typography.titleMedium.copy(
                    fontSize = if (config.title.length > 8) 12.sp else 14.sp,
                ),
                color = config.textColor,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth(),
            )
            if (config.subtitle != null) {
                Text(
                    text = config.subtitle,
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 10.sp),
                    color = config.textColor.copy(alpha = 0.7f),
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}
