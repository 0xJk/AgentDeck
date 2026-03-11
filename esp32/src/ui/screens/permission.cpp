#include "permission.h"
#include "../../state/agent_state.h"

/**
 * Permission overlay — disabled.
 *
 * AWAITING states are visualized through the octopus "?" speech bubble
 * (CreatureState::ASKING in octopus.cpp), matching Android tablet behavior.
 * No separate modal popup needed on this small display.
 */

namespace Screens {

void permissionCreate(lv_obj_t* parent) {
    // No modal created — ASKING state handled by octopus speech bubble
}

void permissionUpdate() {
    // No-op — creature state drives ASKING visual
}

bool permissionVisible() {
    return false;
}

}  // namespace Screens
