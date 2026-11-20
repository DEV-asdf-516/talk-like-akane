#!/usr/bin/env node
// npm bin entry. Running it with no arguments installs for every detected client.
import { main } from '../src/cli.mjs';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  process.stderr.write(`talk-like-akane needs Node.js 22 or newer (found ${process.versions.node}).\n`);
  process.exit(1);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`talk-like-akane: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  },
);
