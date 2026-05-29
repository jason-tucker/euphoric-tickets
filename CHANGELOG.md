# Changelog

## [0.3.0] — 2026-05-29 — Bot rewire onto shared DB (Phase A1+A2)

### Changed
- **`DATABASE_URL` now points at `tickets-db` on `efm-public-net`** — the web (`euphoric-tickets-web`) Postgres container. Bot's own `db` service + `postgres_data` volume **dropped**. The web is the schema owner; `drizzle-kit push` removed from the bot entrypoint (one less race on the same tables).
- **Schema mirrored from web.** The bot's `tickets` table is now the web's table — uuid FKs to `users.id` for opener/assignee/closer, `business_id` instead of `guild_id`, expanded status enum, etc. New files: `src/db/schema/{users,businesses,businessMembers,ticketCategories,ticketMessages}.ts` (verbatim from web; only comment differs). `src/db/schema/ticketSettings.ts` **deleted** — config moved into `businesses` columns. `ticketPanels` stays local (bot-only table for `/panel post|refresh` indexing; will move into the shared schema in a follow-up).
- **`src/services/ticketService.ts`** — `openTicket` resolves business by guild id, looks up category by `(businessId, key)`, picks `category.discordParentCategoryId ?? business.discordFallbackCategoryId` as the Discord parent, and inserts a ticket with uuid FKs. `claimTicket`/`closeTicket` set status + uuid assignee/closer. All writes touch `lastActivityAt`.
- **`src/services/settingsService.ts`** — reads now scope by `guildId` and hit `businesses` (+ `ticketCategories`). `getStaffRoleIds` splits `business.adminRoleIds`. `getPanelCategories` queries `ticket_categories`. New `updateBusinessSettings` and `replaceTicketCategories` for the modal submit.
- **`src/services/ticketLogger.ts`** — `logTicketEvent` is now a no-op pending a `businesses.discord_log_channel_id` column (currently not in web schema). All call sites preserved for easy reinstatement.
- **`/tickets settings` modal** — shrunk from 5 fields to 3 (fallback category, staff role CSV, panel JSON). Submit writes to `businesses` columns and runs `replaceTicketCategories`.

### Added
- **`src/services/userResolver.ts`** — `getOrCreateUserByDiscordId(discordId, profile)` and `getDiscordIdForUserId(userId)` with per-process caches. Race-safe upsert via `onConflictDoUpdate`.
- **`src/services/businessResolver.ts`** — `getBusinessByGuildId` with 60s TTL cache + invalidator.

### Removed
- `db` service + `postgres_data` volume from `docker-compose.yml`.
- `drizzle-kit push` from `scripts/docker-entrypoint.sh`.
- `src/db/schema/ticketSettings.ts`.
- Transcript-channel-id and log-channel-id from settings UI (no equivalent web columns yet; transcript HTML is still DM'd to the opener on close).

### Migration
**Wipe the bot's old Postgres volume.** Settings (category, staff roles, panel JSON) must be re-entered on the web's `/b/<slug>/settings` page (or via the new shrunken `/tickets settings` modal which now writes through to `businesses`). Guilds that have no `businesses` row will see "This server is not configured as a business — ask an admin to create one at https://tickets.euphoric.fm/admin" instead of opening tickets.

Risks: bot now refuses to operate in any guild without a `businesses` row; transcript-channel posting is gone; cold staff-perm checks do one extra DB lookup for `openerUserId → discord_id` (cached after).

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

`v0.3.0 · 97a1fde`
