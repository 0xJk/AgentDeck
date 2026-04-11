#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import sharp from 'sharp';

const ICON_SIZE = 196;
const GAP = 12;
const LABEL_HEIGHT = 24;
const COLS = 5;
const ROWS = 3;
const DEFAULT_DUMP_DIR = join(homedir(), '.agentdeck', 'd200h-dumps');

function usage() {
  console.log(`Usage:
  node scripts/d200h-preview-dump.mjs [zipPath] [--out <dir>]

When zipPath is omitted, the latest *-set_buttons-*.zip from ~/.agentdeck/d200h-dumps is used.
Outputs:
  d200h-contact-sheet.png
  manifest.json
  preview.html
  icons/
`);
}

function parseArgs(argv) {
  let zipPath = null;
  let outDir = join(tmpdir(), 'agentdeck-d200h-preview');

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out requires a directory path');
      outDir = value;
      i += 1;
      continue;
    }
    if (!zipPath) {
      zipPath = arg;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  return { zipPath, outDir: resolve(outDir) };
}

function latestSetButtonsZip() {
  if (!existsSync(DEFAULT_DUMP_DIR)) {
    throw new Error(`D200H dump directory does not exist: ${DEFAULT_DUMP_DIR}`);
  }

  const candidates = readdirSync(DEFAULT_DUMP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.includes('-set_buttons-') && entry.name.endsWith('.zip'))
    .map((entry) => {
      const path = join(DEFAULT_DUMP_DIR, entry.name);
      return { path, mtimeMs: statMtimeMs(path) };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 0) {
    throw new Error(`No *-set_buttons-*.zip dumps found in ${DEFAULT_DUMP_DIR}`);
  }

  return candidates[0].path;
}

function statMtimeMs(path) {
  return statSync(path).mtimeMs;
}

function extractZip(zipPath, extractDir) {
  mkdirSync(extractDir, { recursive: true });
  execFileSync('/usr/bin/unzip', ['-q', zipPath, '-d', extractDir], { stdio: 'pipe' });
}

function iconNameForCell(col, row) {
  if (row === 2 && col === 3) return 'btn13L.png';
  if (row === 2 && col === 4) return 'btn13R.png';
  return `btn${row * 5 + col}.png`;
}

function labelForCell(col, row) {
  if (row === 2 && col === 3) return '13L';
  if (row === 2 && col === 4) return '13R';
  return String(row * 5 + col);
}

function labelSvg(label) {
  return Buffer.from(`<svg width="${ICON_SIZE}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#f3f4f6"/>
    <text x="4" y="16" font-family="Menlo, monospace" font-size="12" fill="#111827">${label}</text>
  </svg>`);
}

async function buildContactSheet(extractDir, outPath) {
  const cellWidth = ICON_SIZE + GAP;
  const cellHeight = ICON_SIZE + LABEL_HEIGHT + GAP;
  const width = COLS * ICON_SIZE + (COLS + 1) * GAP;
  const height = ROWS * (ICON_SIZE + LABEL_HEIGHT) + (ROWS + 1) * GAP;
  const composites = [];

  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const iconName = iconNameForCell(col, row);
      const iconPath = join(extractDir, 'icons', iconName);
      const left = GAP + col * cellWidth;
      const top = GAP + row * cellHeight;
      if (existsSync(iconPath)) {
        composites.push({ input: iconPath, left, top });
      }
      composites.push({ input: labelSvg(labelForCell(col, row)), left, top: top + ICON_SIZE });
    }
  }

  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#f3f4f6',
    },
  })
    .composite(composites)
    .png()
    .toFile(outPath);
}

function htmlForPreview(zipPath, manifest, contactSheetName) {
  const rows = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const key = `${col}_${row}`;
      const button = manifest?.[key] ?? {};
      const view = Array.isArray(button.ViewParam) ? button.ViewParam[0] : button.ViewParam;
      rows.push(`<tr>
        <td>${key}</td>
        <td>${view?.Icon ?? ''}</td>
        <td>${escapeHtml(view?.Text ?? '')}</td>
        <td>${escapeHtml(button.Action ?? '')}</td>
      </tr>`);
    }
  }

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>D200H Dump Preview</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; background: #f8fafc; color: #111827; }
    img { max-width: 100%; height: auto; border: 1px solid #d1d5db; background: #fff; }
    table { border-collapse: collapse; margin-top: 20px; width: 100%; font-size: 13px; }
    th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; }
    th { background: #e5e7eb; }
    code { background: #e5e7eb; padding: 2px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>D200H Dump Preview</h1>
  <p><code>${escapeHtml(zipPath)}</code></p>
  <img src="${contactSheetName}" alt="D200H contact sheet">
  <table>
    <thead><tr><th>Cell</th><th>Icon</th><th>Text</th><th>Action</th></tr></thead>
    <tbody>${rows.join('\n')}</tbody>
  </table>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const zipPath = resolve(args.zipPath ?? latestSetButtonsZip());
  if (!existsSync(zipPath)) throw new Error(`ZIP does not exist: ${zipPath}`);

  rmSync(args.outDir, { recursive: true, force: true });
  mkdirSync(args.outDir, { recursive: true });

  const extractDir = join(args.outDir, 'extracted');
  extractZip(zipPath, extractDir);

  const manifestPath = join(extractDir, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  const contactSheetName = 'd200h-contact-sheet.png';
  const contactSheetPath = join(args.outDir, contactSheetName);
  await buildContactSheet(extractDir, contactSheetPath);

  writeFileSync(join(args.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(args.outDir, 'preview.html'), htmlForPreview(zipPath, manifest, contactSheetName));

  console.log(`ZIP: ${zipPath}`);
  console.log(`Preview: ${join(args.outDir, 'preview.html')}`);
  console.log(`Contact sheet: ${contactSheetPath}`);
  console.log(`Extracted: ${extractDir}`);
}

main().catch((err) => {
  console.error(`d200h-preview-dump: ${err.message}`);
  process.exit(1);
});
