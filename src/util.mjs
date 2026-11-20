// Shared helpers: errors, hashing, safe file inspection, atomic writes, text/JSON formatting.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TOOL = 'talk-like-akane';

// Exit codes (documented in README):
// 0 ok, 1 usage/internal error, 2 nothing to act on (no client detected / not installed),
// 3 conflict or unsafe state (nothing changed), 4 apply failed and was rolled back.
export const EXIT = { OK: 0, ERROR: 1, NOTHING: 2, CONFLICT: 3, ROLLED_BACK: 4 };

export class TlaError extends Error {
  constructor(code, message, { hint, exitCode, details } = {}) {
    super(message);
    this.name = 'TlaError';
    this.code = code;
    this.hint = hint;
    this.details = details;
    this.exitCode = exitCode ?? EXIT.ERROR;
  }
}

export const usageError = (msg, hint) => new TlaError('USAGE', msg, { hint, exitCode: EXIT.ERROR });
export const conflictError = (msg, hint) => new TlaError('CONFLICT', msg, { hint, exitCode: EXIT.CONFLICT });

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

export function toBuffer(data) {
  if (data == null) return null;
  return Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
}

export function bufEqual(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return a.equals(b);
}

/** lstat-based inspection that never follows a symlink silently. */
export function inspect(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { path: p, exists: false };
    throw e;
  }
  if (st.isSymbolicLink()) {
    let real;
    try {
      real = fs.realpathSync(p);
    } catch {
      return { path: p, exists: true, symlink: true, dangling: true };
    }
    const rst = fs.statSync(real);
    return { path: p, exists: true, symlink: true, realPath: real, isFile: rst.isFile(), isDir: rst.isDirectory(), mode: rst.mode & 0o777 };
  }
  return { path: p, exists: true, symlink: false, realPath: p, isFile: st.isFile(), isDir: st.isDirectory(), mode: st.mode & 0o777 };
}

export function readBytesOrNull(p) {
  try {
    return fs.readFileSync(p);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

export function isDirSync(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      // Windows: antivirus/indexers can briefly lock the destination.
      if (i < 8 && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) {
        sleepSync(40 * (i + 1));
        continue;
      }
      throw e;
    }
  }
}

/** Write via temp file in the same directory, then rename over the target. */
export function atomicWrite(file, data, mode) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${TOOL}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', mode ?? 0o644);
  try {
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (mode != null) {
      try {
        fs.chmodSync(tmp, mode);
      } catch {
        /* best effort (umask / Windows) */
      }
    }
    renameWithRetry(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

// ---------- text / JSON formatting that preserves the user's file style ----------

export function detectTextFormat(text) {
  const bom = text.startsWith('﻿');
  const body = bom ? text.slice(1) : text;
  const crlf = (body.match(/\r\n/g) || []).length;
  const lf = (body.match(/\n/g) || []).length - crlf;
  const eol = crlf > 0 && crlf >= lf ? '\r\n' : '\n';
  const m = body.match(/^([ \t]+)\S/m);
  const indent = m ? (m[1].startsWith('\t') ? '\t' : m[1]) : '  ';
  const trailingNewline = body.length === 0 || /\n$/.test(body);
  return { bom, eol, indent, trailingNewline };
}

export function stringifyJson(obj, fmt) {
  let s = JSON.stringify(obj, null, fmt.indent);
  if (fmt.eol !== '\n') s = s.replace(/\n/g, fmt.eol);
  if (fmt.trailingNewline) s += fmt.eol;
  return (fmt.bom ? '﻿' : '') + s;
}

/** Parse a JSON config file. Empty/whitespace-only counts as {}. Throws a conflict on invalid JSON. */
export function parseJsonConfig(bytes, file) {
  const text = bytes ? bytes.toString('utf8') : '';
  const fmt = detectTextFormat(text);
  const body = fmt.bom ? text.slice(1) : text;
  if (body.trim() === '') return { data: {}, fmt: { ...fmt, trailingNewline: true } };
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw conflictError(`${file} is not valid JSON (${e.message}). Nothing was changed.`, 'Fix or move that file, then run the command again.');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw conflictError(`${file} does not contain a JSON object. Nothing was changed.`, 'Fix or move that file, then run the command again.');
  }
  return { data, fmt };
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

export const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Is `child` equal to or inside `parent`? Case-insensitive on Windows. */
export function isWithin(child, parent, platform = process.platform) {
  const norm = (p) => {
    const r = path.resolve(p);
    return platform === 'win32' ? r.toLowerCase() : r;
  };
  const c = norm(child);
  const p = norm(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function displayPath(p, home) {
  if (home && isWithin(p, home)) {
    const rel = path.relative(home, p);
    return rel ? `~${path.sep}${rel}` : '~';
  }
  return p;
}
