# Changelog

All notable changes to this project are documented here. Versions follow [SemVer](https://semver.org/), and each release is tagged `vX.Y.Z`.

## 0.1.0 (2026-11-20)

- First implementation of the one-command installer: `npx -y talk-like-akane@latest`.
- Claude Code: `Akane` output style (`keep-coding-instructions: true`), `outputStyle` activation with restore on uninstall, user-level `SessionStart` command hook, management skill.
- Codex: managed block in the effective global AGENTS file (`AGENTS.override.md` aware), `SessionStart` command hook in `hooks.json` (trust is left to the user), management skill in `~/.agents/skills`.
- Persistent, self-contained hook runner in the per-user data directory (never the npx cache). Fail-open, no network, subagent-aware.
- Commands: `install`, `status`, `set-level`, `set-language`, `update`, `uninstall`, `--dry-run`, `--json`, `--scope user|project`.
- Language `auto` by default with any BCP 47 preference; intensity levels 1–5 (default 4).
- Atomic multi-file changes with rollback, ownership tracking, one-time backups and byte-identical restore.
