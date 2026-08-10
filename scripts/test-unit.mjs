#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = collect(path.join(root, 'test'));
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
process.exitCode = result.status ?? 1;

function collect(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? collect(target) : entry.name.endsWith('.test.js') ? [target] : [];
    })
    .sort();
}
