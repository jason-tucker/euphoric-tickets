# Security Changelog

## v0.7.1 — 2026-06-09 — Security hardening (internal-auth, close-confirm, build context)

### Fixed
- **[F2 / Medium / CWE-862] Missing authorization at the close-confirm step.**
  `executeCloseConfirm` now re-verifies `canClose` (resolved by channel) before
  deleting a ticket channel, and `/tickets close` posts its "Close & delete"
  confirm ephemerally. Previously a non-staff member added to a ticket could click
  a publicly-posted confirm and delete the channel.
- **[F5 / Low→Med / CWE-208] Timing side-channel on the internal token.** The
  `x-internal-token` check now uses `crypto.timingSafeEqual` with a length guard
  instead of `!==`.
- **[F4 / Medium / CWE-538] Secrets/metadata could enter the Docker build cache.**
  Added `.dockerignore` excluding `.git`, `.env*`, `node_modules`, `.claude/`, etc.

### Changed
- **[F1 / Medium / CWE-522] Internal secret reuses the bot token.** Added a loud
  startup warning when `INTERNAL_TOKEN` is unset (the bot token is then used as the
  HTTP shared secret) and documented `INTERNAL_TOKEN` / `WEB_BASE_URL` /
  `INTERNAL_PORT` in `.env.example`. The on-wire value is unchanged (non-breaking);
  setting a dedicated `INTERNAL_TOKEN` on both bot and web retires the fallback.

### Known / deferred (see REMEDIATION_PLAN.md)
- F3 multi-team authorization drift in button/list handlers (Medium).
- F6 non-root container + prod-only deps; F7 CI action pinning + scans;
  F8 fetch timeouts / shutdown; F9 add a test suite; F10/F11 informational.

### Operator actions
- Set `INTERNAL_TOKEN` (`openssl rand -hex 32`) on the bot **and** the web app.
- No secret rotation required — none were found exposed in code or git history.
