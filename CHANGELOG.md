# Changelog

## [0.2.1] — 2026-05-29

### Fixed
- `src/config/env.ts` now coerces empty-string env vars (`UPTIME_KUMA_PUSH_URL=`, `BOT_OWNER_ID=`, etc.) to undefined so optional URL / snowflake validators stop crashing startup on a fresh `.env`.
- `scripts/euphoric-tickets deploy` no longer shell-sources `.env` (broke on values with `*` or `$`) and now passes `--entrypoint=""` to `docker compose run` so the registration script actually runs instead of launching a second full bot instance.
- `scripts/clearCommands.ts` accepts `--global` / `--all` so stale global commands (e.g. left over from a previous bot occupying the same Discord app) can be wiped without writing a one-off.
- Committed `pnpm-lock.yaml` so the Docker build's `pnpm install --frozen-lockfile` step works in CI.

## [0.2.0] — 2026-05-29

### Added
- `tickets.log_channel_id` setting — lifecycle events (open / claim / close / add / remove / rename) post Components V2 cards into a dedicated log channel, separate from the transcript channel.
- Settings UI shows the new log channel row; the settings modal now has 5 fields (category, transcript, log, staff roles, panel JSON).
- `/tickets add @user` and `/tickets remove @user` — staff manages ticket membership by editing channel permission overwrites. Opener cannot be removed (close instead). Each action posts to the log channel.
- `/tickets rename <name>` — staff renames the ticket channel; input is slugified and prefixed with `ticket-<id>-` so ticket numbers stay visible. Logged.
- `/tickets list` — staff lists every open ticket in the guild (id, category, channel, opener, claim status, age). Capped at 25 rows; overflow count shown.
- On close, the HTML transcript is also DM'd to the ticket opener (best-effort — silently skipped if the opener has DMs closed or has left the guild). The transcript is rendered once and used for both the log channel post and the DM.

## [0.1.0] — 2026-05-28

### Added
- Initial scaffold: Discord ticket bot in TypeScript using discord.js v14 + Drizzle + Postgres.
- `/panel post` and `/panel refresh` (sudo) — post or re-render a ticket panel in a channel.
- `/tickets settings` (sudo) — DB-backed configuration UI for tickets category, staff role IDs, transcript channel, and panel ticket categories.
- `/tickets claim` and `/tickets close` — staff control over open tickets, with HTML transcript generation on close.
- Open-ticket flow: button click on panel creates a private channel under the configured category, visible only to opener and staff roles.
- Docker + GHCR build pipeline (GitHub Actions), watchtower-enabled docker-compose, systemd weekly restart timer.
- Bot management CLI at `scripts/euphoric-tickets` mirroring the otterbot/squishybot pattern.

`v0.2.1 · 7368229`
