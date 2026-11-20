// All-or-nothing file changes: plan, then verify against snapshots, apply with atomic writes,
// and roll back every applied change if anything fails.
import fs from 'node:fs';
import path from 'node:path';
import { TlaError, EXIT, atomicWrite, bufEqual, readBytesOrNull, toBuffer, isDirSync } from './util.mjs';

export class Plan {
  constructor() {
    this.ops = []; // { file, before: Buffer|null, after: Buffer|null, label, mode }
    this.rmdirs = []; // directories to remove after success, only if empty
  }

  /** Record a desired change. `before` is what we read at plan time; null means the file is absent. */
  put(file, before, after, { label, mode } = {}) {
    const a = toBuffer(after);
    const existing = this.ops.find((o) => o.file === file);
    if (existing) {
      existing.after = a;
      if (label) existing.label = label;
      if (bufEqual(existing.before, existing.after)) this.ops.splice(this.ops.indexOf(existing), 1);
      return;
    }
    if (bufEqual(before, a)) return;
    this.ops.push({ file, before: before ?? null, after: a, label: label ?? path.basename(file), mode });
  }

  rmdirIfEmpty(dir) {
    if (!this.rmdirs.includes(dir)) this.rmdirs.push(dir);
  }

  get changed() {
    return this.ops.length > 0;
  }

  /** Directories that applying this plan will create (in creation order). */
  missingDirs() {
    const out = [];
    for (const op of this.ops) {
      if (!op.after) continue;
      const chain = [];
      let d = path.dirname(op.file);
      while (!isDirSync(d)) {
        chain.unshift(d);
        const up = path.dirname(d);
        if (up === d) break;
        d = up;
      }
      for (const c of chain) if (!out.includes(c)) out.push(c);
    }
    return out;
  }

  describe() {
    return this.ops.map((o) => ({ action: o.before == null ? 'create' : o.after == null ? 'delete' : 'modify', file: o.file, label: o.label }));
  }
}

function modeFor(op) {
  if (op.mode != null) return op.mode;
  try {
    return fs.statSync(op.file).mode & 0o777;
  } catch {
    return 0o644;
  }
}

export function applyPlan(plan, { faultAfterOps } = {}) {
  // 1. Every target must still be exactly what we planned against (catches concurrent edits).
  for (const op of plan.ops) {
    const cur = readBytesOrNull(op.file);
    if (!bufEqual(cur, op.before)) {
      throw new TlaError('CONCURRENT_MODIFICATION', `${op.file} changed while talk-like-akane was running. Nothing was changed.`, {
        exitCode: EXIT.CONFLICT,
        hint: 'Run the command again.',
      });
    }
  }
  const createdDirs = [];
  const applied = [];
  try {
    for (const op of plan.ops) {
      if (faultAfterOps != null && applied.length >= faultAfterOps) throw new Error(`fault injected after ${applied.length} operation(s)`);
      if (op.after) {
        mkdirTracked(path.dirname(op.file), createdDirs);
        atomicWrite(op.file, op.after, modeFor(op));
      } else {
        fs.unlinkSync(op.file);
      }
      applied.push(op);
    }
  } catch (err) {
    const rollbackErrors = rollback(applied, createdDirs);
    throw new TlaError(
      'APPLY_FAILED',
      `Could not apply changes (${err.code ? `${err.code}: ` : ''}${err.message}). ${rollbackErrors.length ? 'Rollback was INCOMPLETE.' : 'Every change from this run was rolled back.'}`,
      { exitCode: EXIT.ROLLED_BACK, details: { rollbackErrors, failedOp: plan.ops[applied.length]?.file } },
    );
  }
  for (const dir of [...plan.rmdirs].sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      /* not empty or already gone: keep it */
    }
  }
  return { applied: applied.length, createdDirs };
}

function mkdirTracked(dir, created) {
  const chain = [];
  let d = dir;
  while (!isDirSync(d)) {
    chain.unshift(d);
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  for (const c of chain) {
    fs.mkdirSync(c);
    created.push(c);
  }
}

function rollback(applied, createdDirs) {
  const errors = [];
  for (const op of [...applied].reverse()) {
    try {
      if (op.before == null) {
        try {
          fs.unlinkSync(op.file);
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
      } else {
        atomicWrite(op.file, op.before, modeFor(op));
      }
    } catch (e) {
      errors.push(`${op.file}: ${e.message}`);
    }
  }
  for (const d of [...createdDirs].reverse()) {
    try {
      fs.rmdirSync(d);
    } catch {
      /* ignore */
    }
  }
  return errors;
}
