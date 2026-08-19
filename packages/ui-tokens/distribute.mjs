#!/usr/bin/env node
/**
 * Copies packages/ui-tokens/tokens.css into each app's public/ directory
 * so it can be served at /tokens.css without modifying server code.
 *
 * Usage: node packages/ui-tokens/distribute.mjs
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(__dirname, 'tokens.css');

const targets = [
  '../../apps/ajun-runtime/public/tokens.css',
  '../../apps/project-progress-board/public/tokens.css',
  '../../apps/xiaod-media-transcriber/public/tokens.css',
];

for (const rel of targets) {
  const dest = path.resolve(__dirname, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(source, dest);
}

console.log(`ui-tokens: distributed tokens.css to ${targets.length} apps`);
