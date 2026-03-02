package dev.agentdeck.terrarium.renderer

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.nativeCanvas
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.terrarium.TerrariumState
import dev.agentdeck.terrarium.EnvironmentVisualState
import dev.agentdeck.terrarium.creature.BubbleSystem
import dev.agentdeck.terrarium.creature.CrayfishCreature
import dev.agentdeck.terrarium.creature.OctopusCreature
import dev.agentdeck.terrarium.creature.DataParticleSystem
import dev.agentdeck.terrarium.environment.KelpField
import dev.agentdeck.terrarium.environment.RockFormation
import dev.agentdeck.terrarium.environment.WaterEffect

/**
 * Main color terrarium renderer — composites all layers onto a Compose Canvas.
 * Creatures and environment elements manage their own animation state;
 * this renderer calls update(dt) then draw(scope) on each in layer order.
 */
@Composable
fun ColorTerrariumCanvas(
    state: TerrariumState,
    waterEffect: WaterEffect,
    rockFormation: RockFormation,
    kelpField: KelpField,
    mainCrayfish: CrayfishCreature,
    workerCrayfish: List<CrayfishCreature> = emptyList(),
    dataParticles: DataParticleSystem,
    octopuses: List<OctopusCreature>,
    bubbleSystem: BubbleSystem,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height

        // Layer 1: Deep-sea gradient background
        drawDeepSeaBackground(w, h, state.environment)

        // Layer 2: Animated water surface (waves + glow)
        waterEffect.drawSurface(this)

        // Layer 3: Caustics overlay
        waterEffect.draw(this)

        // Layer 4: Rocks + sand (bottom)
        rockFormation.draw(this)

        // Layer 5: Kelp
        kelpField.draw(this)

        // Layer 6: LED cables on rocks
        rockFormation.drawLEDs(this, state.environment)

        // Layer 6.5: Back-layer fish (behind creatures for 3D depth)
        dataParticles.drawBackLayer(this)

        // Layer 7a: Worker crayfish (smaller, behind main)
        for (wc in workerCrayfish) wc.draw(this)

        // Layer 7b: Main crayfish (on rocks, bottom-right)
        mainCrayfish.draw(this)

        // Layer 9: Octopuses (all coding agent avatars)
        for (oct in octopuses) oct.draw(this)

        // Layer 9.5: Front-layer fish (in front of creatures for 3D depth)
        dataParticles.drawFrontLayer(this)

        // Layer 10: Bubbles (on top of creatures)
        bubbleSystem.draw(this)

        // Layer 10.5: Glass-etched logo (on glass surface, above water contents)
        drawGlassLogo(w, h)

        // Layer 11: Error tint overlay
        if (state.hasError) {
            drawRect(
                color = TerrariumColors.ErrorTint,
                size = Size(w, h),
            )
        }
    }
}

/** Glass-etched "AgentDeck" logo — subtle engraving on the tank glass surface, centered top. */
private fun DrawScope.drawGlassLogo(w: Float, h: Float) {
    val canvas = drawContext.canvas.nativeCanvas
    val fontSize = h * 0.056f
    val x = w * 0.5f
    val y = h * 0.06f

    val paint = android.graphics.Paint().apply {
        isAntiAlias = true
        typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.BOLD)
        textSize = fontSize
        letterSpacing = 0.08f
        textAlign = android.graphics.Paint.Align.CENTER
    }

    // Shadow pass — depth effect (dark offset)
    paint.color = android.graphics.Color.argb(20, 0, 0, 0) // ~8% black
    canvas.drawText("AgentDeck", x + 1f, y + 1f, paint)

    // Main pass — etched glass text
    paint.color = android.graphics.Color.argb(46, 255, 255, 255) // ~18% white
    canvas.drawText("AgentDeck", x, y, paint)
}

/** Gradient background — shifts with environment state. */
private fun DrawScope.drawDeepSeaBackground(w: Float, h: Float, env: EnvironmentVisualState) {
    val topColor = when (env) {
        EnvironmentVisualState.DARK -> TerrariumColors.DeepSea.copy(alpha = 0.5f)
        EnvironmentVisualState.CALM -> TerrariumColors.ShallowWater
        EnvironmentVisualState.ACTIVE -> TerrariumColors.ShallowWater.copy(alpha = 0.9f)
        EnvironmentVisualState.ALERT -> Color(0xFF1A3D5C)
    }
    val bottomColor = TerrariumColors.DeepSea

    drawRect(
        brush = Brush.verticalGradient(
            colors = listOf(topColor, TerrariumColors.MidWater, bottomColor),
            startY = 0f,
            endY = h,
        ),
        size = Size(w, h),
    )
}

