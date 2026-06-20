#!/usr/bin/env node
/* ============================================================
   build.cjs — Pacer asset bundler for Capacitor.
   Copies web assets to www/ and injects the capacitor.js shim
   into index.html so Capacitor plugins are available at runtime.

   CommonJS (.cjs) on purpose: package.json sets "type":"module" so the app
   source can be ES modules (and unit-testable under `node --test`), while this
   build script keeps using require()/__dirname via the .cjs extension.

   Usage:
     node build.cjs         # copy assets → www/
     npm run cap:sync       # build + cap sync android
     npm run cap:run        # build + cap run android (device/emulator)
   ============================================================ */

'use strict';

const fs   = require('fs');
const path = require('path');

const SRC = __dirname;
const OUT = path.join(__dirname, 'www');

const WEB_FILES = [
  'index.html',
  'style.css',
  'app.js',
  'utils.js',
  'pace.js',
  'timer.js',
  'cues.js',
  'native.js',
  'sw.js',
  'templates.json',
  'manifest.json',
];

// ── Helpers ──────────────────────────────────────────────────

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

// ── Build ─────────────────────────────────────────────────────

console.log('Building www/…');
fs.mkdirSync(OUT, { recursive: true });

// Copy flat files
for (const file of WEB_FILES) {
  const src = path.join(SRC, file);
  if (!fs.existsSync(src)) {
    console.warn(`  skip (missing): ${file}`);
    continue;
  }
  copy(src, path.join(OUT, file));
  console.log(`  copied: ${file}`);
}

// Copy icons directory
const iconsDir = path.join(SRC, 'icons');
if (fs.existsSync(iconsDir)) {
  copyDir(iconsDir, path.join(OUT, 'icons'));
  console.log('  copied: icons/');
}

// Inject <script src="capacitor.js"></script> into www/index.html.
// Capacitor's CLI places capacitor.js in www/ during `cap sync` — it
// must load before app.js so window.Capacitor is defined at module init.
const htmlPath  = path.join(OUT, 'index.html');
let   html      = fs.readFileSync(htmlPath, 'utf8');
const marker    = '<script type="module" src="app.js"></script>';
const injection = '<script src="capacitor.js"></script>\n  ' + marker;

if (!html.includes('capacitor.js')) {
  if (html.includes(marker)) {
    html = html.replace(marker, injection);
    fs.writeFileSync(htmlPath, html, 'utf8');
    console.log('  injected: capacitor.js shim into index.html');
  } else {
    console.warn('  WARNING: could not find app.js script tag — capacitor.js not injected');
  }
} else {
  console.log('  skipped:  capacitor.js already present in index.html');
}

console.log('\nDone. Run "npm run cap:sync" to sync with the Android project.');
