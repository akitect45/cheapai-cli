#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv).catch((err) => {
  console.error('fatal:', err?.stack || err?.message || err);
  process.exit(1);
});
