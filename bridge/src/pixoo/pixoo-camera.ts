/**
 * Pixoo64 Camera System — zoom/pan coordinate transform + zone director.
 *
 * Virtual world is normalized 0~1 in both axes. Camera defines a viewport
 * with center (cx, cy) and zoom level. At zoom=1.0 the full world is visible;
 * at zoom=2.0 only the center quarter is visible but everything is 2× larger.
 *
 * Rendering pipeline:
 *   1. Environment → 64×64 world buffer (pixel coords 0~63)
 *   2. blitWithCamera() → 64×64 output buffer (crop + nearest-neighbor scale)
 *   3. Scaled creatures → output buffer (high-detail grid, camera-aware sizing)
 */

const W = 64;

// ===== Types =====

export interface Camera {
  cx: number;   // center X in normalized world (0~1)
  cy: number;   // center Y in normalized world (0~1)
  zoom: number; // 1.0 = full view, 2.0 = 2× magnification
}

export const CAMERA_WIDE: Camera = { cx: 0.5, cy: 0.5, zoom: 1.2 };

// ===== Camera Zones =====

export interface CameraZone {
  name: string;
  cx: number;
  cy: number;
  zoom: number;
  duration: number; // seconds to hold before advancing
}

export const ZONES: Record<string, CameraZone> = {
  wide:     { name: 'wide',     cx: 0.5,  cy: 0.5,  zoom: 1.2, duration: 5 },
  octopus:  { name: 'octopus',  cx: 0.38, cy: 0.45, zoom: 2.0, duration: 8 },
  crayfish: { name: 'crayfish', cx: 0.72, cy: 0.55, zoom: 2.0, duration: 8 },
  school:   { name: 'school',   cx: 0.5,  cy: 0.40, zoom: 1.6, duration: 6 },
  surface:  { name: 'surface',  cx: 0.5,  cy: 0.15, zoom: 1.8, duration: 5 },
};

// ===== Coordinate Transforms =====

/** World (0~1) → screen pixel (0~63). */
export function worldToScreen(wx: number, wy: number, cam: Camera): [number, number] {
  return [
    (wx - cam.cx) * W * cam.zoom + W / 2,
    (wy - cam.cy) * W * cam.zoom + W / 2,
  ];
}

/** Screen pixel → world (0~1). */
export function screenToWorld(sx: number, sy: number, cam: Camera): [number, number] {
  return [
    (sx - W / 2) / (W * cam.zoom) + cam.cx,
    (sy - W / 2) / (W * cam.zoom) + cam.cy,
  ];
}

/** Check if a world-space point is within the camera viewport. */
export function isVisible(wx: number, wy: number, cam: Camera, padding = 0.05): boolean {
  const halfView = 0.5 / cam.zoom + padding;
  return Math.abs(wx - cam.cx) <= halfView && Math.abs(wy - cam.cy) <= halfView;
}

/** Clamp camera so the viewport stays within world bounds. */
export function clampCamera(cam: Camera): Camera {
  const halfView = 0.5 / cam.zoom;
  return {
    cx: Math.max(halfView, Math.min(1 - halfView, cam.cx)),
    cy: Math.max(halfView, Math.min(1 - halfView, cam.cy)),
    zoom: cam.zoom,
  };
}

/** Linearly interpolate between two cameras. */
export function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  const s = Math.max(0, Math.min(1, t));
  return {
    cx: a.cx + (b.cx - a.cx) * s,
    cy: a.cy + (b.cy - a.cy) * s,
    zoom: a.zoom + (b.zoom - a.zoom) * s,
  };
}

/** Smoothstep ease-in-out. */
export function easeInOut(t: number): number {
  const s = Math.max(0, Math.min(1, t));
  return s * s * (3 - 2 * s);
}

// ===== Blit: world buffer → output with camera transform =====

/**
 * Crop + nearest-neighbor scale from a 64×64 world buffer into a 64×64 output.
 * At zoom 1.0: 1:1 copy.  At zoom 2.0: center 32×32 upscaled to fill output.
 */
export function blitWithCamera(world: Uint8Array, output: Uint8Array, cam: Camera): void {
  const cxPx = cam.cx * W;
  const cyPx = cam.cy * W;
  const viewSize = W / cam.zoom;
  const left = cxPx - viewSize / 2;
  const top = cyPx - viewSize / 2;

  for (let sy = 0; sy < W; sy++) {
    for (let sx = 0; sx < W; sx++) {
      const wx = Math.floor(left + sx / cam.zoom);
      const wy = Math.floor(top + sy / cam.zoom);
      const dstIdx = (sy * W + sx) * 3;
      if (wx >= 0 && wx < W && wy >= 0 && wy < W) {
        const srcIdx = (wy * W + wx) * 3;
        output[dstIdx] = world[srcIdx];
        output[dstIdx + 1] = world[srcIdx + 1];
        output[dstIdx + 2] = world[srcIdx + 2];
      }
      // out-of-bounds stays black (Uint8Array zero-init)
    }
  }
}

// ===== Camera Director — state-based zone scheduling =====

interface DirectorState {
  currentZone: CameraZone;
  targetZone: CameraZone;
  camera: Camera;
  zoneTimer: number;
  transitionT: number;
  transitioning: boolean;
  zoneIndex: number;
}

const TRANSITION_SEC = 4; // ease-in-out zone transition

let ds: DirectorState | null = null;

function getZoneCycle(hasGateway: boolean): CameraZone[] {
  return hasGateway
    ? [ZONES.wide, ZONES.octopus, ZONES.crayfish, ZONES.school, ZONES.surface]
    : [ZONES.wide, ZONES.octopus, ZONES.school, ZONES.surface];
}

function resolveZoneCamera(
  zone: CameraZone,
  octoPos?: { x: number; y: number },
  schoolPos?: { x: number; y: number },
): Camera {
  if (zone.name === 'octopus' && octoPos) {
    return { cx: octoPos.x, cy: octoPos.y, zoom: zone.zoom };
  }
  if (zone.name === 'school' && schoolPos) {
    return { cx: schoolPos.x, cy: schoolPos.y, zoom: zone.zoom };
  }
  return { cx: zone.cx, cy: zone.cy, zoom: zone.zoom };
}

/**
 * Advance the camera director by `dt` seconds and return the current camera.
 *
 * @param agentState  'idle' | 'processing' | 'awaiting' (simplified)
 * @param dt          seconds since last call (~1.2s at Pixoo push rate)
 * @param hasGateway  whether OpenClaw gateway is available
 * @param octoPos     dynamic octopus world position for tracking
 * @param schoolPos   dynamic tetra school center for tracking
 */
export function updateDirector(
  agentState: 'idle' | 'processing' | 'awaiting',
  dt: number,
  hasGateway: boolean,
  octoPos?: { x: number; y: number },
  schoolPos?: { x: number; y: number },
): Camera {
  if (!ds) {
    ds = {
      currentZone: ZONES.wide,
      targetZone: ZONES.wide,
      camera: { ...CAMERA_WIDE },
      zoneTimer: 0,
      transitionT: 0,
      transitioning: false,
      zoneIndex: 0,
    };
  }

  // --- Processing / Awaiting: track octopus ---
  if (agentState === 'processing' || agentState === 'awaiting') {
    const yOff = agentState === 'awaiting' ? -0.05 : 0; // up for "?" bubble
    const target: Camera = {
      cx: octoPos?.x ?? 0.38,
      cy: (octoPos?.y ?? 0.45) + yOff,
      zoom: 2.0,
    };
    ds.camera = lerpCamera(ds.camera, target, Math.min(1, dt * 0.8));
    ds.transitioning = false;
    ds.zoneTimer = 0;
    return clampCamera(ds.camera);
  }

  // --- IDLE: cycle through zones ---
  const cycle = getZoneCycle(hasGateway);

  if (ds.transitioning) {
    ds.transitionT += dt / TRANSITION_SEC;
    if (ds.transitionT >= 1) {
      ds.transitionT = 1;
      ds.transitioning = false;
      ds.currentZone = ds.targetZone;
      ds.zoneTimer = 0;
    }
    const t = easeInOut(ds.transitionT);
    const fromCam = resolveZoneCamera(ds.currentZone, octoPos, schoolPos);
    const toCam = resolveZoneCamera(ds.targetZone, octoPos, schoolPos);
    ds.camera = lerpCamera(fromCam, toCam, t);
  } else {
    ds.zoneTimer += dt;
    const zoneCam = resolveZoneCamera(ds.currentZone, octoPos, schoolPos);
    ds.camera = lerpCamera(ds.camera, zoneCam, Math.min(1, dt * 2));

    if (ds.zoneTimer >= ds.currentZone.duration) {
      ds.zoneIndex = (ds.zoneIndex + 1) % cycle.length;
      ds.targetZone = cycle[ds.zoneIndex];
      ds.transitioning = true;
      ds.transitionT = 0;
    }
  }

  return clampCamera(ds.camera);
}

/** Jump to a specific zone immediately (for preview). */
export function setZone(zoneName: string): void {
  const zone = ZONES[zoneName];
  if (!zone) return;
  ds = {
    currentZone: zone,
    targetZone: zone,
    camera: { cx: zone.cx, cy: zone.cy, zoom: zone.zoom },
    zoneTimer: 0,
    transitionT: 0,
    transitioning: false,
    zoneIndex: Object.keys(ZONES).indexOf(zoneName),
  };
}

/** Override camera directly (for preview --zoom). */
export function setOverride(cam: Camera): void {
  ds = {
    currentZone: ZONES.wide,
    targetZone: ZONES.wide,
    camera: { ...cam },
    zoneTimer: 0,
    transitionT: 0,
    transitioning: false,
    zoneIndex: 0,
  };
}

/** Reset director state (e.g. on reconnect). */
export function resetDirector(): void {
  ds = null;
}
