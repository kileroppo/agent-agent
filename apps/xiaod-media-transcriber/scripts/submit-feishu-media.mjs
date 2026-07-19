#!/usr/bin/env node
import path from 'node:path';

const args = process.argv.slice(2);
const index = args.indexOf('--path');
const mediaPath = index >= 0 ? args[index + 1] : '';

if (!mediaPath || !path.isAbsolute(mediaPath)) {
  console.error(JSON.stringify({ error: 'usage: submit-feishu-media.mjs --path <absolute-media-path>' }));
  process.exitCode = 2;
} else {
  const response = await fetch('http://127.0.0.1:4318/api/internal/feishu-media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaPath, originalName: path.basename(mediaPath) })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(JSON.stringify({ error: payload.error || `intake failed: HTTP ${response.status}` }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({
      taskId: payload.job?.id || null,
      status: payload.job?.status || null,
      duplicate: Boolean(payload.duplicate)
    }));
  }
}
