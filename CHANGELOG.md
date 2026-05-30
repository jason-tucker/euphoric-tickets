# Changelog

## [0.5.3] — 2026-05-29 — Lantern P1: mirror new ticket_categories columns

### Changed
- `src/db/schema/ticketCategories.ts` mirrored from the web side: adds `allow_role_ids` (not null default `''`), `staff_role_ids` (not null default `''`), and `first_message_template` (nullable). Drizzle-kit push picks them up on next bot deploy so the bot's writes don't fail against the new shape. No functional bot change in this release — P2 wires up the gating and P4 reads `first_message_template`.

Schema lockstep with euphoric-tickets-web v0.6.3 (lantern P1).

## [0.5.2] — 2026-05-29 — Internal-note thread sync

### Fixed
- `src/bot/events/messageCreate.ts` now matches inbound messages against both `tickets.discord_channel_id` AND `tickets.discord_internal_thread_id`, so staff replies typed directly in the per-ticket private internal thread are relayed into `ticket_messages` with `source='internal'` (and only the main channel maps to `source='discord'`). Dedupe by `discord_message_id` unchanged. The bot creates the thread via the web's `createPrivateThread` call (bot token), so it's auto-joined and receives `MESSAGE_CREATE` in the private thread. Closes euphoric-tickets#12.

## [0.5.1] — 2026-05-29

### Added
- **"Open in web" Link button on the ticket-channel welcome card (D2 polish)** — `buildTicketWelcome()` now accepts an optional `webUrl` and renders a `ButtonStyle.Link` next to Claim and Close when set. `openTicket()` passes `WEB_BASE_URL/b/<slug>/tickets/<id>`; the claim re-render preserves it via `getBusinessByGuildId(guild.id)`. Staff and the opener can jump straight to the web companion without copy-pasting.

The bulk of D2 (Container + Section + Buttons V2 layout) was already on the welcome card; this just lands the missing link. The bigger Components V2 information panel restyling (opener body in a Section, etc.) stays on the to-do list as a polish follow-up.

## [0.5.0] — 2026-05-29 — Scheduled cleanup + Discord-side admin parity

### Added
- **`src/bot/scheduledCleanup.ts` (Phase B2)** — hourly sweep that fetches every closed ticket whose host business has a non-null `delete_closed_after_days` and whose `closed_at` is older than that window, then deletes the Discord channel and nulls the four `discord_*` columns on the row. DB row + `ticket_messages` stay so transcripts survive. Wired into `src/index.ts` alongside the existing health-push timer.
- **`/admin` slash command (Phases A0a + A0b)** — sudo-only. Two subcommand groups:
  - `sudo grant <user>`, `sudo revoke <user>`, `sudo list` — flip `users.is_sudo`. Grant upserts the target into `users` if missing. List renders as Components V2 ephemeral.
  - `business create slug name guild_id [kind=host] [parent_host_slug]` — inserts a host or client business. Validates slug + snowflake formats; client kind requires `parent_host_slug` resolving to an existing host. Invalidates the business resolver cache for the guild after insert.
  - `business list` — Components V2 ephemeral split into Hosts and Clients sections.
  - `business delete <slug>` — drops the row (cascade nukes its categories and tickets — irreversible).

Settings + categories are still edited via the existing `/tickets settings` ephemeral modal — no new slash commands needed there. With this release, sudo can manage the entire system from inside Discord: create / list / delete businesses, grant sudo, configure categories, and run the ticket lifecycle.

Lands euphoric-tickets#5 (scheduled cleanup), #9 (settings parity), #10 (sudo parity).

## [0.4.0] — 2026-05-29 — Bidirectional sync, DM-on-close link, unclaim+assign

### Added
- **Bidirectional message sync (Phase A3)** — `src/bot/events/messageCreate.ts` registers a `MESSAGE_CREATE` listener. For every message in a channel that maps to a `tickets.discord_channel_id`, the bot inserts a `ticket_messages` row with `source='discord'`, dedupes by `discord_message_id`, upserts the author into `users`, and bumps `tickets.last_activity_at`. Skips bot messages, webhook posts (those are the web's own outbound), and DMs. Web ticket view now shows Discord-side replies live.
- **Close DM web link (Phase A4)** — `closeTicket()` now resolves the host business from the guild and appends `https://tickets.euphoric.fm/b/<slug>/tickets/<id>` to the opener DM so they can keep reading the conversation on the web after the channel goes away. Link omitted gracefully if the guild has no business row. New env: `WEB_BASE_URL` (defaults to `https://tickets.euphoric.fm`).
- **`/tickets unclaim`** — releases the current ticket back to the open pool, clears `assigneeUserId`. Allowed for staff, sudo, OR the current assignee (so anyone holding a ticket can hand it off themselves).
- **`/tickets assign <user>`** — staff-only. Sets `status='claimed'` + `assigneeUserId` for the chosen Discord member. Upserts the target user into the shared `users` table if they don't have a row yet.

### Changed
- `src/config/env.ts`: added `WEB_BASE_URL` to the schema (URL, default `https://tickets.euphoric.fm`). Treated as optional in `.env` so existing `.env` files keep working.

Closes web-side parity gap on euphoric-tickets#11 (claim/unclaim/assign) and lands euphoric-tickets#3, #4.

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

`v0.5.3 · 5ca5fa9`
