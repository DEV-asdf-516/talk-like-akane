// Argument parsing, command dispatch and human-readable output.
import { makeContext } from './paths.mjs';
import { reconcile, uninstall, parseLevel, CLIENT_NAMES } from './install.mjs';
import { computeStatus, formatStatus, formatTarget, statusExitCode } from './status.mjs';
import { normalizeLanguage, describeLanguage } from './locale.mjs';
import { packageVersion } from './render.mjs';
import { TlaError, EXIT, usageError, displayPath } from './util.mjs';

const HELP = `talk-like-akane: the Akane persona for Claude Code and Codex, active automatically in every session.

Usage:
  npx -y talk-like-akane@latest                 install for every detected client (user scope, level 4, language auto)
  npx -y talk-like-akane@latest install [options]
  npx -y talk-like-akane@latest status [--json] [--project-root <dir>]
  npx -y talk-like-akane@latest set-level <1-5> [--scope user|project]
  npx -y talk-like-akane@latest set-language <auto|tag> [--scope user|project]
  npx -y talk-like-akane@latest update [--target ...] [--scope ...]
  npx -y talk-like-akane@latest uninstall [--target ...] [--scope ...]

Options:
  --target auto|claude|codex|both   which client(s) (default: auto = every detected client)
  --scope user|project              user = global for your account (default); project = one repository
  --project-root <dir>              repository for --scope project (default: git root of the current dir)
  --level 1..5                      teasing intensity (default 4, or the value already installed)
  --language auto|<BCP 47 tag>      reply-language preference (default auto = follow the user's language)
  --dry-run                         show the planned file changes and write nothing
  --json                            machine-readable output (status, --dry-run)
  -h, --help                        show this help
  -v, --version                     print the version

After installing, just start \`claude\` or \`codex\` as usual. No slash command is needed.
Exit codes: 0 ok, 1 usage/internal error, 2 nothing to do (no client detected / not installed),
3 conflict or degraded state (nothing changed), 4 failed and rolled back.
`;

const COMMANDS = new Set(['install', 'update', 'status', 'set-level', 'set-language', 'uninstall', 'help']);
const VALUE_FLAGS = new Set(['target', 'scope', 'project-root', 'level', 'language']);
const BOOL_FLAGS = new Set(['dry-run', 'json', 'help', 'version', 'activate']);
const ALLOWED = {
  install: ['target', 'scope', 'project-root', 'level', 'language', 'dry-run', 'json', 'activate'],
  update: ['target', 'scope', 'project-root', 'dry-run', 'json'],
  'set-level': ['target', 'scope', 'project-root', 'dry-run', 'json'],
  'set-language': ['target', 'scope', 'project-root', 'dry-run', 'json'],
  uninstall: ['target', 'scope', 'project-root', 'dry-run', 'json'],
  status: ['project-root', 'json'],
  help: [],
};

export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') flags.help = true;
    else if (a === '-v') flags.version = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = a.slice(2, eq === -1 ? undefined : eq);
      if (VALUE_FLAGS.has(name)) {
        const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
        if (v === undefined || (eq === -1 && v.startsWith('--'))) throw usageError(`--${name} needs a value.`);
        flags[name] = v;
      } else if (BOOL_FLAGS.has(name)) {
        if (eq !== -1) throw usageError(`--${name} does not take a value.`);
        flags[name] = true;
      } else throw usageError(`Unknown option --${name}. See --help.`);
    } else if (a.startsWith('-') && a !== '-') throw usageError(`Unknown option ${a}. See --help.`);
    else positionals.push(a);
  }
  let cmd = 'install';
  if (positionals.length && COMMANDS.has(positionals[0])) cmd = positionals.shift();
  else if (positionals.length) throw usageError(`Unknown command "${positionals[0]}". See --help.`);
  return { cmd, flags, positionals };
}

const dp = (ctx, p) => displayPath(p, ctx.home);

function printPlan(ctx, res) {
  const lines = [];
  if (!res.plan.length) lines.push('  (no file changes)');
  for (const op of res.plan) lines.push(`  ${op.action.padEnd(6)} ${dp(ctx, op.file)}  [${op.label}]`);
  return lines;
}

function reportInstall(ctx, res, json) {
  if (json) {
    ctx.out(JSON.stringify({ ok: true, ...res, scope: res.scope }, null, 2) + '\n');
    return;
  }
  const scopeLabel = res.scope.scope === 'user' ? 'user scope' : `project ${res.scope.root}`;
  const out = [`talk-like-akane ${res.version} ${res.mode}${res.dryRun ? ' (dry run)' : ''}: ${scopeLabel}, level ${res.level}/5, language ${describeLanguage(res.language)}`];
  if (res.dryRun) {
    out.push('', 'Planned changes:', ...printPlan(ctx, res), '', 'Dry run: nothing was written.');
    ctx.out(out.join('\n') + '\n');
    return;
  }
  out.push(res.changed ? `Applied ${res.plan.length} file change(s).` : 'Already up to date. No files changed.');
  const status = computeStatus(ctx, { projectRoot: res.scope.root ?? undefined });
  const inst = status.installs.find((i) => i.key === res.scope.key);
  for (const r of res.results) {
    out.push('');
    const det = r.detected;
    if (!det.detected) out.push(`  ! ${CLIENT_NAMES[r.client]} was not detected; installed anyway because you asked for it.`);
    const t = inst?.targets?.[r.client];
    if (t) out.push(...formatTarget(ctx, t));
    for (const n of r.notes) out.push(`    - ${n}`);
  }
  out.push('');
  if (res.mode === 'install' || res.mode === 'update') {
    out.push('Next: start `claude` or `codex` as usual and just talk. Akane answers from the first message, with no slash command.');
  } else {
    out.push('New sessions pick up the change.');
  }
  out.push('Restart any Claude Code / Codex session that was already running.');
  if (res.results.some((r) => r.client === 'codex')) {
    out.push('Codex: if it asks you to review the talk-like-akane hook in /hooks, that is expected. Akane already works through AGENTS.md either way.');
  }
  if (res.scope.scope === 'project') {
    out.push('Project scope wrote files inside the repository (.claude/, .agents/, .codex/, AGENTS.md). They contain machine-specific paths, so do not commit them unless you mean to.');
  }
  out.push('A persona is followed by the model, not enforced: hooks and instructions are installed, but character quality is not guaranteed.');
  ctx.out(out.join('\n') + '\n');
}

function reportUninstall(ctx, res, json) {
  if (json) {
    ctx.out(JSON.stringify({ ok: true, ...res }, null, 2) + '\n');
    return;
  }
  const out = [`talk-like-akane uninstall${res.dryRun ? ' (dry run)' : ''}: ${res.targets.map((t) => CLIENT_NAMES[t]).join(' + ')}`];
  out.push(...printPlan(ctx, res));
  for (const r of res.results) for (const n of r.notes) out.push(`  - ${CLIENT_NAMES[r.client]}: ${n}`);
  if (res.dryRun) out.push('', 'Dry run: nothing was written.');
  else {
    out.push('', res.fullyRemoved ? 'Removed everything talk-like-akane installed. The npx cache is managed by npm and was not touched.' : 'Removed the selected targets. Other installs remain.');
    out.push('Restart running sessions to drop the persona from them.');
  }
  ctx.out(out.join('\n') + '\n');
}

function check(cmd, flags) {
  for (const k of Object.keys(flags)) {
    if (k === 'help' || k === 'version') continue;
    if (!ALLOWED[cmd].includes(k)) throw usageError(`--${k} is not valid for "${cmd}". See --help.`);
  }
}

export async function main(argv, overrides = {}) {
  const ctx = makeContext(overrides);
  let json = false;
  try {
    const { cmd, flags, positionals } = parseArgs(argv);
    json = !!flags.json;
    if (flags.version) {
      ctx.out(packageVersion() + '\n');
      return EXIT.OK;
    }
    if (flags.help || cmd === 'help') {
      ctx.out(HELP);
      return EXIT.OK;
    }
    check(cmd, flags);
    const common = { target: flags.target ?? 'auto', scope: flags.scope ?? 'user', projectRoot: flags['project-root'], dryRun: !!flags['dry-run'] };
    switch (cmd) {
      case 'install': {
        if (positionals.length) throw usageError(`Unexpected argument "${positionals[0]}".`);
        const res = reconcile(ctx, { mode: 'install', ...common, level: flags.level !== undefined ? parseLevel(flags.level) : undefined, language: flags.language !== undefined ? normalizeLanguage(flags.language) : undefined });
        reportInstall(ctx, res, json);
        return EXIT.OK;
      }
      case 'update': {
        if (positionals.length) throw usageError(`Unexpected argument "${positionals[0]}".`);
        reportInstall(ctx, reconcile(ctx, { mode: 'update', ...common }), json);
        return EXIT.OK;
      }
      case 'set-level': {
        if (positionals.length !== 1) throw usageError('Usage: set-level <1-5>');
        reportInstall(ctx, reconcile(ctx, { mode: 'set-level', ...common, level: parseLevel(positionals[0]) }), json);
        return EXIT.OK;
      }
      case 'set-language': {
        if (positionals.length !== 1) throw usageError('Usage: set-language <auto|BCP 47 tag>, e.g. set-language ja');
        reportInstall(ctx, reconcile(ctx, { mode: 'set-language', ...common, language: normalizeLanguage(positionals[0]) }), json);
        return EXIT.OK;
      }
      case 'uninstall': {
        if (positionals.length) throw usageError(`Unexpected argument "${positionals[0]}".`);
        reportUninstall(ctx, uninstall(ctx, common), json);
        return EXIT.OK;
      }
      case 'status': {
        if (positionals.length) throw usageError(`Unexpected argument "${positionals[0]}".`);
        const report = computeStatus(ctx, { projectRoot: flags['project-root'] });
        ctx.out(json ? JSON.stringify(report, null, 2) + '\n' : formatStatus(ctx, report));
        return statusExitCode(report);
      }
      default:
        throw usageError(`Unknown command ${cmd}`);
    }
  } catch (e) {
    if (e instanceof TlaError) {
      if (json) ctx.out(JSON.stringify({ ok: false, error: { code: e.code, message: e.message, hint: e.hint ?? null, details: e.details ?? null } }, null, 2) + '\n');
      else ctx.err(`talk-like-akane: ${e.message}\n${e.hint ? `${e.hint}\n` : ''}`);
      return e.exitCode;
    }
    ctx.err(`talk-like-akane: internal error: ${e && e.stack ? e.stack : e}\n`);
    return EXIT.ERROR;
  }
}
