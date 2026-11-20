// Install state: what we own, what we changed, previous values and backup ids. Never secrets.
import fs from 'node:fs';
import path from 'node:path';
import { statePath, dataDir } from './paths.mjs';
import { conflictError, readBytesOrNull, TlaError, EXIT } from './util.mjs';

export const STATE_SCHEMA = 1;

export function loadState(ctx) {
  const file = statePath(ctx);
  const before = readBytesOrNull(file);
  if (!before) return { file, before: null, data: { schema: STATE_SCHEMA, tool: 'talk-like-akane', installs: {} } };
  let data;
  try {
    data = JSON.parse(before.toString('utf8'));
  } catch {
    throw conflictError(`State file ${file} is corrupted. Nothing was changed.`, 'Run `status` to see what is installed. Move the state file away only if you know what you are doing.');
  }
  if (!data || typeof data !== 'object' || typeof data.installs !== 'object' || data.installs === null) {
    throw conflictError(`State file ${file} has an unexpected shape. Nothing was changed.`);
  }
  if (data.schema > STATE_SCHEMA) {
    throw conflictError(`State file ${file} was written by a newer talk-like-akane (schema ${data.schema}).`, 'Run the latest version: npx -y talk-like-akane@latest');
  }
  return { file, before, data };
}

export function serializeState(data) {
  return JSON.stringify(data, null, 2) + '\n';
}

/**
 * Cross-process lock for mutating commands. Returns { release, createdParents }.
 * release({ removeDirIfEmpty, extraDirs }) drops the lock and removes the data dir and any
 * directories created on the way to it, but only when they are empty.
 */
export function acquireLock(ctx) {
  const dir = dataDir(ctx);
  const created = [];
  const chain = [];
  for (let d = dir; !fs.existsSync(d); d = path.dirname(d)) {
    chain.unshift(d);
    if (path.dirname(d) === d) break;
  }
  for (const d of chain) {
    fs.mkdirSync(d);
    created.push(d);
  }
  const lock = path.join(dir, '.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      const release = ({ removeDirIfEmpty = false, extraDirs = [] } = {}) => {
        try {
          fs.unlinkSync(lock);
        } catch {
          /* ignore */
        }
        const dirs = removeDirIfEmpty ? [dir, ...extraDirs, ...created] : created;
        for (const d of [...new Set(dirs)].sort((a, b) => b.length - a.length)) {
          try {
            fs.rmdirSync(d);
          } catch {
            /* not empty (install succeeded) or already gone */
          }
        }
      };
      return { release, createdParents: created.filter((d) => d !== dir) };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const age = Date.now() - (readBytesOrNull(lock) ? fs.statSync(lock).mtimeMs : 0);
      if (age > 120_000) {
        try {
          fs.unlinkSync(lock);
        } catch {
          /* raced */
        }
        continue;
      }
      throw new TlaError('LOCKED', `Another talk-like-akane process is running (lock: ${lock}).`, {
        exitCode: EXIT.CONFLICT,
        hint: 'Wait for it to finish. If none is running, delete the lock file.',
      });
    }
  }
  throw new TlaError('LOCKED', `Could not acquire ${lock}.`, { exitCode: EXIT.CONFLICT });
}
