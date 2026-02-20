import sharp from 'sharp';
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(__dirname, '../plugin/bound.serendipity.agentdeck.sdPlugin/static/imgs');

mkdirSync(outputDir, { recursive: true });

// All SVGs designed at 40x40 viewBox, will be rendered at target sizes
const svgs = {
  // Plugin icon — rounded "C" with diamond accent (Claude-style)
  plugin: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    <path d="M22 6C13.2 6 6 13.2 6 22s7.2 16 16 16c3.2 0 6.2-1 8.7-2.6" fill="none" stroke="white" stroke-width="3.5" stroke-linecap="round"/>
    <polygon points="32,8 36,14 32,20 28,14" fill="white"/>
  </svg>`,

  // Category icon — same as plugin
  category: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    <path d="M22 6C13.2 6 6 13.2 6 22s7.2 16 16 16c3.2 0 6.2-1 8.7-2.6" fill="none" stroke="white" stroke-width="3.5" stroke-linecap="round"/>
    <polygon points="32,8 36,14 32,20 28,14" fill="white"/>
  </svg>`,

  // Response — chat bubble with reply arrow
  response: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    <path d="M6 8h28a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H14l-6 6V28H6a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z" fill="none" stroke="white" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M22 15l4 4-4 4" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M14 19h12" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"/>
  </svg>`,

  // Stop — octagon stop symbol
  stop: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    <polygon points="14,4 26,4 36,14 36,26 26,36 14,36 4,26 4,14" fill="none" stroke="white" stroke-width="2.5" stroke-linejoin="round"/>
    <rect x="14" y="14" width="12" height="12" rx="1" fill="white"/>
  </svg>`,

  // Mode — gear/settings icon
  mode: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    <circle cx="20" cy="20" r="6" fill="none" stroke="white" stroke-width="2.5"/>
    <path d="M20 4v4M20 32v4M4 20h4M32 20h4M8.7 8.7l2.8 2.8M28.5 28.5l2.8 2.8M31.3 8.7l-2.8 2.8M11.5 28.5l-2.8 2.8" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`,

  // Option — list/menu icon (three lines with bullets)
  option: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    <circle cx="10" cy="12" r="2.5" fill="white"/>
    <line x1="17" y1="12" x2="33" y2="12" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="10" cy="20" r="2.5" fill="white"/>
    <line x1="17" y1="20" x2="33" y2="20" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="10" cy="28" r="2.5" fill="white"/>
    <line x1="17" y1="28" x2="33" y2="28" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`,

  // History — clock with circular arrow
  history: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    <circle cx="22" cy="22" r="13" fill="none" stroke="white" stroke-width="2.5"/>
    <polyline points="22,13 22,22 29,26" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M10 8v8h8" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M10 16A14 14 0 0 1 22 8a14 14 0 0 1 13 9" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`,

  // Voice — microphone icon
  voice: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    <rect x="15" y="4" width="10" height="18" rx="5" fill="none" stroke="white" stroke-width="2.5"/>
    <path d="M9 20a11 11 0 0 0 22 0" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="20" y1="31" x2="20" y2="37" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="14" y1="37" x2="26" y2="37" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`,

  // Session — terminal window with prompt
  session: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    <rect x="3" y="6" width="34" height="28" rx="3" fill="none" stroke="white" stroke-width="2.5"/>
    <path d="M10 16l5 5-5 5" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="19" y1="26" x2="28" y2="26" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`,

  // Usage — bar chart icon
  usage: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    <rect x="6" y="22" width="6" height="14" rx="1" fill="white" opacity="0.5"/>
    <rect x="14" y="14" width="6" height="22" rx="1" fill="white" opacity="0.7"/>
    <rect x="22" y="8" width="6" height="28" rx="1" fill="white" opacity="0.85"/>
    <rect x="30" y="18" width="6" height="18" rx="1" fill="white"/>
  </svg>`,
};

// Size specs: plugin/category are 28/56, action icons are 20/40
const sizeMap = {
  plugin:   [28, 56],
  category: [28, 56],
  response: [20, 40],
  stop:     [20, 40],
  mode:     [20, 40],
  option:   [20, 40],
  history:  [20, 40],
  voice:    [20, 40],
  session:  [20, 40],
  usage:    [20, 40],
};

let count = 0;
for (const [name, svg] of Object.entries(svgs)) {
  const [size1x, size2x] = sizeMap[name];
  const buf = Buffer.from(svg);

  await sharp(buf, { density: 300 })
    .resize(size1x, size1x)
    .png()
    .toFile(resolve(outputDir, `${name}.png`));

  await sharp(buf, { density: 300 })
    .resize(size2x, size2x)
    .png()
    .toFile(resolve(outputDir, `${name}@2x.png`));

  count += 2;
  console.log(`  ${name}.png (${size1x}x${size1x}) + ${name}@2x.png (${size2x}x${size2x})`);
}

console.log(`\nGenerated ${count} icon files in ${outputDir}`);
