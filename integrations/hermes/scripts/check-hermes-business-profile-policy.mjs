#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export const HERMES_BUSINESS_PROFILE_POLICY = Object.freeze({
  'display.platforms.feishu.memory_notifications':false,
  'memory.nudge_interval':0,
  'memory.write_approval':true,
  'skills.creation_nudge_interval':0,
  'skills.write_approval':true,
  'curator.enabled':false,
});

export function evaluateHermesBusinessProfilePolicy(config = {}) {
  const violations = [];
  for (const [key, expected] of Object.entries(HERMES_BUSINESS_PROFILE_POLICY)) {
    const actual = readNested(config, key);
    if (actual !== expected) violations.push({ key, expected, actual });
  }
  return {
    compliant:violations.length === 0,
    violations,
  };
}

export async function checkHermesBusinessProfileHomes(profileHomes, {
  readFile = fs.readFile,
} = {}) {
  const results = [];
  for (const candidate of profileHomes) {
    const profileHome = path.resolve(expandHome(candidate));
    const configPath = path.join(profileHome, 'config.yaml');
    const source = await readFile(configPath, 'utf8');
    const config = yaml.load(source) || {};
    results.push({
      profileHome,
      configPath,
      ...evaluateHermesBusinessProfilePolicy(config),
    });
  }
  return results;
}

function readNested(value, dottedKey) {
  return dottedKey.split('.').reduce(
    (current, key) => current && typeof current === 'object' ? current[key] : undefined,
    value,
  );
}

function expandHome(candidate) {
  const value = String(candidate || '').trim();
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseArgs(args) {
  const homes = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--home' || !args[index + 1]) {
      throw new Error('用法：--home <HERMES_HOME>，可重复提供。');
    }
    homes.push(args[index + 1]);
    index += 1;
  }
  if (!homes.length) throw new Error('至少提供一个 --home。');
  return homes;
}

async function main() {
  const homes = parseArgs(process.argv.slice(2));
  const results = await checkHermesBusinessProfileHomes(homes);
  let drift = false;
  for (const result of results) {
    if (result.compliant) {
      process.stdout.write(`PASS ${result.profileHome}\n`);
      continue;
    }
    drift = true;
    process.stdout.write(`DRIFT ${result.profileHome}\n`);
    for (const item of result.violations) {
      process.stdout.write(
        `  ${item.key}: expected=${JSON.stringify(item.expected)} actual=${JSON.stringify(item.actual)}\n`,
      );
    }
  }
  if (drift) process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
