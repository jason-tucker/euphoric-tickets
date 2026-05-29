# Changelog

## [0.2.0] — 2026-05-29

### Added
- `tickets.log_channel_id` setting — lifecycle events (open / claim / close / add / remove / rename) post Components V2 cards into a dedicated log channel, separate from the transcript channel.
- Settings UI shows the new log channel row; the settings modal now has 5 fields (category, transcript, log, staff roles, panel JSON).
- `/tickets add @user` and `/tickets remove @user` — staff manages ticket membership by editing channel permission overwrites. Opener cannot be removed (close instead). Each action posts to the log channel.

## [0.1.0] — 2026-05-28

### Added
- Initial scaffold: Discord ticket bot in TypeScript using discord.js v14 + Drizzle + Postgres.
- `/panel post` and `/panel refresh` (sudo) — post or re-render a ticket panel in a channel.
- `/tickets settings` (sudo) — DB-backed configuration UI for tickets category, staff role IDs, transcript channel, and panel ticket categories.
- `/tickets claim` and `/tickets close` — staff control over open tickets, with HTML transcript generation on close.
- Open-ticket flow: button click on panel creates a private channel under the configured category, visible only to opener and staff roles.
- Docker + GHCR build pipeline (GitHub Actions), watchtower-enabled docker-compose, systemd weekly restart timer.
- Bot management CLI at `scripts/euphoric-tickets` mirroring the otterbot/squishybot pattern.

`v0.1.0 · d3df309`
