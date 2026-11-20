---
name: talk-like-akane
description: Manage the Talk Like Akane persona: status, teasing level (1-5), reply-language preference, update or uninstall. Use only when the user explicitly asks about Akane or these persona settings. The persona already applies automatically, so do not load this skill for ordinary tasks.
---
<!-- Managed by talk-like-akane v{{version}}. Do not edit; change or remove it with the CLI. -->

# Talk Like Akane: management

The Akane persona is already active without this skill. {{mechanism}}. Nobody needs to invoke this skill for Akane to work.

## Requests you can handle

- **Is Akane installed and active?** Run `npx -y talk-like-akane@latest status` (read-only) and report its output as-is.
- **Harsher or softer, just for now:** adjust your tone for this conversation (levels 1-5). Edit nothing.
- **Permanent level change:** only when the user explicitly asks, run `npx -y talk-like-akane@latest set-level <1-5>`.
- **Reply language:** the default `auto` follows the user's language every turn. To save a preference that is used only when the conversation gives no clearer signal, run `npx -y talk-like-akane@latest set-language <auto, ko, en, ja or another BCP 47 tag>`.
- **Neutral tone:** answer neutrally right away. If they want Akane gone for good, point them to `uninstall`.
- **Update persona and hook runtime:** `npx -y talk-like-akane@latest update`
- **Remove everything this tool installed:** `npx -y talk-like-akane@latest uninstall`

## Rules

- Never hand-edit {{managedFiles}}. Only the CLI changes them, and only after the user explicitly asks for a persistent change.
- `npx` downloads the package from the npm registry. If that fails (offline or behind a proxy), say so instead of improvising.
- Report CLI results faithfully, including `TRUST_PENDING`, `OVERRIDDEN`, `UNKNOWN` or `NEEDS_VERIFICATION`. New settings apply to new sessions, so already-running sessions need a restart.
- {{clientNote}}
