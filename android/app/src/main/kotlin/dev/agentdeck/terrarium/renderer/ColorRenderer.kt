package dev.agentdeck.terrarium.renderer

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.terrarium.TerrariumState
import dev.agentdeck.terrarium.EnvironmentVisualState
import dev.agentdeck.terrarium.creature.BubbleSystem
import dev.agentdeck.terrarium.creature.CrayfishCreature
import dev.agentdeck.terrarium.creature.CloudCreature
import dev.agentdeck.terrarium.creature.OpenCodeCreature
import dev.agentdeck.terrarium.creature.OctopusCreature
import dev.agentdeck.terrarium.creature.DataParticleSystem
import dev.agentdeck.terrarium.environment.KelpField
import dev.agentdeck.terrarium.environment.LightRaySystem
import dev.agentdeck.terrarium.environment.PlanktonSystem
import dev.agentdeck.terrarium.environment.RockFormation
import dev.agentdeck.terrarium.environment.SandDisturbance
import dev.agentdeck.terrarium.environment.WaterEffect
import dev.agentdeck.terrarium.environment.WaterSurface

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
    cloudCreatures: List<CloudCreature> = emptyList(),
    openCodeCreatures: List<OpenCodeCreature> = emptyList(),
    bubbleSystem: BubbleSystem,
    lightRaySystem: LightRaySystem,
    planktonSystem: PlanktonSystem,
    waterSurface: WaterSurface,
    sandDisturbance: SandDisturbance,
    drawMainCrayfish: Boolean = true,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height

        // Layer 1: Deep-sea gradient background
        drawDeepSeaBackground(w, h, state.environment)

        // Layer 2: Caustics overlay
        waterEffect.draw(this)

        // Layer 2.5: God rays (light shafts from surface)
        lightRaySystem.draw(this)

        // Layer 2.7: Back-layer plankton (behind everything)
        planktonSystem.drawBackLayer(this)

        // Layer 4: Rocks + sand (bottom)
        rockFormation.draw(this)

        // Layer 4.5: Sand disturbance particles
        sandDisturbance.draw(this)

        // Layer 5: Kelp + ground cover grass
        kelpField.draw(this)

        // Layer 6: LED cables on rocks
        rockFormation.drawLEDs(this, state.environment)

        // Layer 6.5: Back-layer fish (behind creatures for 3D depth)
        dataParticles.drawBackLayer(this)

        // Layer 7a: Worker crayfish (smaller, behind main)
        for (wc in workerCrayfish) wc.draw(this)

        // Layer 7b: Main crayfish (on rocks, bottom-right)
        if (drawMainCrayfish) {
            mainCrayfish.draw(this)
        }

        // Layer 9: Octopuses (all coding agent avatars)
        for (oct in octopuses) oct.draw(this)

        // Layer 9.2: Cloud creatures (Codex CLI agents — float above octopuses)
        for (cloud in cloudCreatures) cloud.draw(this)

        // Layer 9.3: OpenCode creatures (geometric nested-square logo)
        for (oc in openCodeCreatures) oc.draw(this)

        // Layer 9.5: Front-layer fish (in front of creatures for 3D depth)
        dataParticles.drawFrontLayer(this)

        // Layer 9.7: Front-layer plankton (in front of creatures)
        planktonSystem.drawFrontLayer(this)

        // Layer 10: Bubbles (on top of creatures, includes creature exhales)
        bubbleSystem.draw(this)

        // Layer 10.5: Water surface line
        waterSurface.draw(this)

        // Layer 11: Error tint overlay
        if (state.hasError) {
            drawRect(
                color = TerrariumColors.ErrorTint,
                size = Size(w, h),
            )
        }
    }
}

// Pre-computed background colors — avoids per-frame Color.copy() allocations
private val BG_DARK_TOP = TerrariumColors.DeepSea.copy(alpha = 0.5f)
private val BG_ACTIVE_TOP = TerrariumColors.ShallowWater.copy(alpha = 0.9f)
private val BG_ALERT_TOP = Color(0xFF1A3D5C)

/** Gradient background — shifts with environment state. */
private fun DrawScope.drawDeepSeaBackground(w: Float, h: Float, env: EnvironmentVisualState) {
    val topColor = when (env) {
        EnvironmentVisualState.DARK -> BG_DARK_TOP
        EnvironmentVisualState.CALM -> TerrariumColors.ShallowWater
        EnvironmentVisualState.ACTIVE -> BG_ACTIVE_TOP
        EnvironmentVisualState.ALERT -> BG_ALERT_TOP
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
