package dev.agentdeck.ui.eink

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import dev.agentdeck.terrarium.TerrariumState
import dev.agentdeck.terrarium.renderer.EinkTerrariumView

/**
 * Aquarium-style bordered frame for the terrarium creature animation.
 * Rounded corners evoke glass tank edges. Used in e-ink landscape layout.
 */
@Composable
fun EinkAquariumFrame(
    state: TerrariumState,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .clip(RoundedCornerShape(8.dp))
            .border(3.dp, Color.Black, RoundedCornerShape(8.dp))
            .padding(2.dp),
    ) {
        EinkTerrariumView(state = state, modifier = Modifier.fillMaxSize())
    }
}

/**
 * Backward-compatible alias for [EinkAquariumFrame].
 */
@Composable
fun EinkPictureFrame(
    state: TerrariumState,
    modifier: Modifier = Modifier,
) {
    EinkAquariumFrame(state = state, modifier = modifier)
}
