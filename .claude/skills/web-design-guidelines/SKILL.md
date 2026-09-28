---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
metadata:
  author: vercel
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

# Web Interface Guidelines

Review files for compliance with Web Interface Guidelines.

1. Read the rules in [guidelines.md](guidelines.md) (pinned copy of vercel-labs/web-interface-guidelines `command.md`, fetched 2026-09-28 — no network needed).
2. Read the specified files (templates in `src/build.mjs`, `server/*-page*.mjs`, `public/*.js`, `public/style.css`), or ask which ones.
3. Check against all rules; output findings in the terse `file:line` format described there.

## INNSIDER overrides (take precedence over guidelines.md)

- Russian typography: quotes «ёлочки» (inner „лапки“), not “ ”; sentence case for headings and buttons, not Title Case; ellipsis `…`; non-breaking space between number and unit (`12,4&nbsp;млн&nbsp;₽`).
- House codes from CLAUDE.md win: monochrome, no rounded corners or shadows, calm tone without pressure.
- React/Next-specific rules (hydration, `useState`, `nuqs`, `<Link>`) apply only by analogy — the site is static HTML + vanilla JS.
