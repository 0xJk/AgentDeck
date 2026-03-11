#pragma once

#include <cstdint>
#include "../../state/agent_state.h"

namespace Particles {

void init();

/** Spawn particles near working agents. Call every frame. */
void update(float dt, float time, CreatureState octState, uint8_t octCount,
            CrayfishState cfState, bool showCrayfish);

/** Render all active particles. */
void render(uint16_t* buf, int w, int h, float time);

/** Get nearest food crumb position for tetra pursuit. Returns false if no food. */
bool nearestFood(float fx, float fy, float& outX, float& outY, float& outDist);

/** Mark food near pos as eaten (accelerate fade). */
void eatNear(float fx, float fy, float radius);

}  // namespace Particles
