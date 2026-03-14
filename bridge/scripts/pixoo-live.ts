#!/usr/bin/env npx tsx
/**
 * Pixoo64 Live Preview — standalone HTTP server for browser-based monitoring.
 *
 * Renders frames in real-time with mock or bridge-relayed state.
 * Open http://localhost:9190/pixoo in a browser.
 *
 * Usage:
 *   npx tsx bridge/scripts/pixoo-live.ts [options]
 *
 * Options:
 *   --state idle|processing|awaiting   Agent state (default: idle)
 *   --usage 0-100                      5h rate limit % (default: 30)
 *   --gateway                          Show crayfish
 *   --port N                           HTTP port (default: 9190)
 *   --camera wide|octopus|crayfish|school|surface   Lock camera zone
 *   --cycle                            Auto-cycle through states
 */

import { createServer } from 'node:http';
import { renderFrame, setZone, resetDirector, ZONES } from '../src/pixoo/pixoo-renderer.js';
import { State, PermissionMode } from '../src/types.js';
import type { StateUpdateEvent, UsageEvent } from '../src/types.js';
import type { SessionInfo } from '@agentdeck/shared/protocol';

// ===== CLI args =====

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
}
function hasFlag(name: string): boolean { return args.includes(`--${name}`); }

const stateMap: Record<string, State> = {
  idle: State.IDLE, processing: State.PROCESSING,
  awaiting: State.AWAITING_OPTION, permission: State.AWAITING_PERMISSION,
};

let currentState = stateMap[getArg('state', 'idle')] ?? State.IDLE;
const usagePct = parseInt(getArg('usage', '30'), 10);
const hasGateway = hasFlag('gateway');
const port = parseInt(getArg('port', '9190'), 10);
const cameraZone = getArg('camera', '');
const cycleMode = hasFlag('cycle');

// Camera setup
resetDirector();
if (cameraZone && ZONES[cameraZone]) setZone(cameraZone);

// State cycling
if (cycleMode) {
  const states = [State.IDLE, State.PROCESSING, State.AWAITING_OPTION, State.IDLE];
  let stateIdx = 0;
  setInterval(() => {
    stateIdx = (stateIdx + 1) % states.length;
    currentState = states[stateIdx];
  }, 8000);
}

// ===== Mock data =====

function getStateEvent(): StateUpdateEvent {
  return {
    type: 'state_update', state: currentState,
    permissionMode: PermissionMode.DEFAULT,
    projectName: 'live-preview', modelName: 'opus-4',
    gatewayAvailable: hasGateway,
  };
}

const usageEvent: UsageEvent = {
  type: 'usage_update', sessionDurationSec: 600,
  inputTokens: 50000, outputTokens: 12000, toolCalls: 8,
  fiveHourPercent: usagePct,
};

const sessions: SessionInfo[] = [
  { id: 'live-1', port: 9120, projectName: 'live-preview', agentType: 'claude-code', alive: true },
];
if (hasGateway) {
  sessions.push({ id: 'oc-1', port: 18789, projectName: 'live-preview', agentType: 'openclaw', alive: true, state: 'processing' });
}

// ===== BMP generator =====

function rgbToBmp(rgb: Uint8Array, w: number, h: number): Buffer {
  const rowBytes = w * 3;
  const rowPad = (4 - (rowBytes % 4)) % 4;
  const paddedRow = rowBytes + rowPad;
  const imageSize = paddedRow * h;
  const fileSize = 54 + imageSize;
  const buf = Buffer.alloc(fileSize);

  buf[0] = 0x42; buf[1] = 0x4D;
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(imageSize, 34);

  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 3;
    const dstRow = 54 + y * paddedRow;
    for (let x = 0; x < w; x++) {
      const si = srcRow + x * 3;
      const di = dstRow + x * 3;
      buf[di] = rgb[si + 2];
      buf[di + 1] = rgb[si + 1];
      buf[di + 2] = rgb[si];
    }
  }
  return buf;
}

// ===== HTML page =====

const STATE_NAMES: Record<number, string> = {
  [State.IDLE]: 'IDLE', [State.PROCESSING]: 'PROCESSING',
  [State.AWAITING_OPTION]: 'AWAITING', [State.AWAITING_PERMISSION]: 'PERMISSION',
};

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pixoo Live Preview</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;
  display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:20px}
h1{font-size:14px;color:#64748b;letter-spacing:1px;text-transform:uppercase}
.frame-box{position:relative;border-radius:12px;overflow:hidden;
  box-shadow:0 0 40px rgba(59,130,246,0.15),0 0 80px rgba(59,130,246,0.05)}
canvas{display:block;image-rendering:pixelated;image-rendering:crisp-edges}
.hud{display:flex;gap:20px;font-size:12px;color:#64748b}
.hud .val{color:#94a3b8;font-weight:600}
.state-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle}
.controls{display:flex;gap:8px}
.controls button{background:#1e293b;color:#94a3b8;border:1px solid #334155;border-radius:6px;
  padding:4px 12px;font-size:11px;cursor:pointer;transition:all 0.15s}
.controls button:hover{background:#334155;color:#e2e8f0}
.controls button.active{background:#3b82f6;color:#fff;border-color:#3b82f6}
.paused canvas{opacity:0.4}
</style>
</head>
<body>
<h1>Pixoo 64×64 Live Preview (standalone)</h1>
<div class="frame-box" id="framebox">
  <canvas id="cv" width="512" height="512"></canvas>
</div>
<div class="hud">
  <span><span class="state-dot" id="dot" style="background:#22c55e"></span><span class="val" id="state">IDLE</span></span>
  <span>FPS <span class="val" id="fps">0</span></span>
  <span>Frame <span class="val" id="fnum">0</span></span>
  <span>Scale <span class="val" id="scaleLabel">8×</span></span>
</div>
<div class="controls">
  <button id="btnPause">Pause</button>
  <button data-s="4">4×</button>
  <button data-s="8" class="active">8×</button>
  <button data-s="12">12×</button>
</div>
<script>
const cv=document.getElementById('cv'),ctx=cv.getContext('2d');
let scale=8,paused=false,frameNum=0,frameCount=0,displayFps=0,lastTime=performance.now();
const stateColors={IDLE:'#22c55e',PROCESSING:'#3b82f6',AWAITING:'#f59e0b',PERMISSION:'#f59e0b'};

document.querySelectorAll('button[data-s]').forEach(b=>b.addEventListener('click',()=>{
  scale=+b.dataset.s;cv.width=cv.height=64*scale;
  document.getElementById('scaleLabel').textContent=scale+'×';
  document.querySelectorAll('button[data-s]').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
}));
document.getElementById('btnPause').addEventListener('click',function(){
  paused=!paused;this.textContent=paused?'Resume':'Pause';
  document.getElementById('framebox').classList.toggle('paused',paused);
});

const img=new Image();
img.onload=function(){
  ctx.imageSmoothingEnabled=false;
  ctx.drawImage(img,0,0,cv.width,cv.height);
  frameNum++;document.getElementById('fnum').textContent=frameNum;
  frameCount++;
  const now=performance.now();
  if(now-lastTime>=1000){displayFps=frameCount;frameCount=0;lastTime=now;
    document.getElementById('fps').textContent=displayFps;}
  if(!paused)setTimeout(fetchFrame,800);
};
img.onerror=()=>setTimeout(()=>{if(!paused)fetchFrame()},2000);

function fetchFrame(){
  img.src='/frame?t='+Date.now();
}

// Poll state name
setInterval(async()=>{
  try{const r=await fetch('/state');const d=await r.json();
    document.getElementById('state').textContent=d.state;
    document.getElementById('dot').style.background=stateColors[d.state]||'#64748b';
  }catch{}
},2000);

fetchFrame();
</script>
</body>
</html>`;

// ===== HTTP server =====

const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/pixoo') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.url?.startsWith('/frame')) {
    const rgb = renderFrame(getStateEvent(), usageEvent, sessions);
    const bmp = rgbToBmp(rgb, 64, 64);
    res.writeHead(200, {
      'Content-Type': 'image/bmp',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(bmp);
    return;
  }

  if (req.url === '/state') {
    const name = STATE_NAMES[currentState] || 'IDLE';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: name }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(port, () => {
  const stName = Object.entries(stateMap).find(([, v]) => v === currentState)?.[0] || 'idle';
  console.log(`Pixoo Live Preview — http://localhost:${port}/pixoo`);
  console.log(`  state=${stName} usage=${usagePct}% gateway=${hasGateway}${cameraZone ? ' camera=' + cameraZone : ''}${cycleMode ? ' cycle=true' : ''}`);
  console.log(`  Press Ctrl+C to stop\n`);
});
