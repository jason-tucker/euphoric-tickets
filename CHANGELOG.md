# Changelog

## [0.5.16] — 2026-05-30 — Lantern P18: single-leader bot (advisory lock)

### Added
- **`src/bot/leader.ts`** — `ensureLeadership()` blocks (polling every 30s) until this instance holds a Postgres session-level advisory lock on a dedicated connection, so when the same image runs on several VPS only ONE connects to the Discord gateway. When the leader dies its session drops, the lock releases, and a follower takes over within ~30s. `LEADER_ELECTION=off` skips the wait on single-VPS deploys. Wired into `index.ts` before `client.login()`; releases on graceful shutdown.

## [0.5.15] — 2026-05-30 — Lantern P16 mirror: ticket_external_members

### Added
- `ticket_external_members` schema mirror (web-owned) — groundwork for adding Discord users who aren't in the guild to a ticket. No bot behavior change.

## [0.5.14] — 2026-05-30 — Lantern P14: bot DM gateway

### Added
- The bot now **responds to DMs** instead of dropping them. A user who messages the bot directly gets a one-time (10-min cooldown) explainer: DMs don't reach staff — open a ticket from the server panel or on the web. Added the `DirectMessages` gateway intent.

## [0.5.13] — 2026-05-30 — Lantern P13: notifications (bot side)

### Added
- **`src/bot/internalHttp.ts`** — tiny internal HTTP server (`INTERNAL_PORT`, default 8787) exposing `POST /api/internal/dm` (authed by `INTERNAL_TOKEN`) so the web dispatcher can DM through the bot. Disabled when no token is set.
- **`src/services/notifyBridge.ts`** — `dispatchNotify()` POSTs to the web's `/api/internal/notify` after a Discord-origin new ticket (`openTicket`) or reply (relay). Internal-thread messages never notify.
- New env: `INTERNAL_TOKEN`, `INTERNAL_PORT`. `user_notification_prefs` schema mirrored.

## [0.5.12] — 2026-05-30 — Lantern P12: persistent error log (bot)

### Added
- **`persistError(level, source, message, { stack, context })`** in `services/logger.ts` — logs to stdout AND inserts a row into `bot_errors` (best-effort, fire-and-forget; a DB failure never masks the original error). Lazy imports avoid a startup cycle.
- **`bot_errors` table** (schema mirrored from web): `id bigserial, level, source, message, stack, context jsonb, created_at` + index on `created_at`.
- **5-day retention sweep** in `scheduledCleanup.ts` — `DELETE FROM bot_errors WHERE created_at < now() - interval '5 days'`, runs alongside the hourly closed-channel cleanup.
- Startup-resync orphan + missing-panel warnings now route through `persistError` so they surface on the web's `/admin/errors`.

Closes euphoric-tickets#17.

## [0.5.11] — 2026-05-30 — Lantern P11: startup resync

### Added
- **`src/bot/startupResync.ts`** — runs once on `clientReady` (best-effort; never blocks boot). Three idempotent passes:
  1. **Orphan scan** — open tickets whose `discord_channel_id` no longer resolves get `needs_attention=true` and their `discord_*` columns nulled.
  2. **Panel reconcile** — verifies each `ticket_panels` message still exists; logs a warning to re-run `/panel post` if not.
  3. **Message backfill** — for every open ticket with a live channel, `backfillChannelMessages(…, 100)` imports anything posted while the bot was down (dedupe by `discord_message_id`).
- **`tickets.needs_attention`** boolean column (mirrored on the web; the web shows an amber banner on flagged tickets).

Closes euphoric-tickets#16.

## [0.5.10] — 2026-05-30 — Lantern P5: change a ticket's category (bot)

### Added
- **`changeTicketCategory()` service** — updates `tickets.category_id`, best-effort moves the Discord channel under the new category's parent (per-category → team fallback), grants the new category's staff roles channel access (additive), and posts a silent `-# Ticket category changed to … by @x` footer. Refuses a no-op move.
- **`/tickets category <key>`** — admin-only slash command to move the current ticket.
- **"🗂️ Category" button on the welcome card** — opens an ephemeral category select (`tk:changecat:` → `tk:changecat_sel:`); both handlers enforce admin. New `interactions/buttons/ticketChangeCategory.ts`, routed in `interactionCreate` (added a `isStringSelectMenu()` branch).

Closes euphoric-tickets#15.

## [0.5.9] — 2026-05-30 — Lantern P4: welcome-card redesign + custom first message

### Changed
- **`buildTicketWelcome()` redesigned (Components V2).** Compact info header rendered as `-#` subtext (ticket #, category emoji + label, opener mention, opened-at relative timestamp, claimer when set), the **ticket reason as the dominant body**, and Claim / Close / Open-in-web buttons underneath. Dropped the noisy "Staff: @role" line from the card — staff are still pinged via the separate ping line on open.
- **`openTicket()` reads `category.first_message_template`** (added in P1) and substitutes `{{user}}`, `{{ticketId}}`, `{{subject}}`, `{{category}}` via the new shared `renderFirstMessage()` helper. When a template is set it becomes the card's body; otherwise the default prompt is used. The card is sent with `allowedMentions: { parse: [] }` so a `{{user}}` mention renders without re-pinging the opener.
- **Claim re-render** (`ticketClaim.ts`) now re-fetches the category emoji + template and re-renders the same first message, so claiming a ticket no longer reverts the body to the default.

Admins author the template on the web team-settings category editor (shipped in web v0.6.3). The "Change category" button on the card is deferred to P5 (it shares P5's resolver).

Closes euphoric-tickets#14.

## [0.5.8] — 2026-05-30 — /tickets convert + attachment capture

### Added
- **`/tickets convert`** (admin-only) — registers the current text channel as a ticket and imports recent history. Options: `category` (key, optional), `subject` (optional), `opener` (user, optional → defaults to the invoker). Guards: server must be a configured team; channel must not already be a ticket. Best-effort creates a per-channel webhook so the web can post user-spoofed replies, backfills up to 100 messages, and posts a silent `-# Channel converted to ticket #N by @x` footer. Replies with the web link.
- **`src/services/messageBackfill.ts`** — `extractAttachments(msg)` + `backfillChannelMessages(channel, ticketId, opts)`. Skips bot/webhook/system messages, dedupes by `discord_message_id`, preserves original timestamps, and captures attachments. Reused by the P11 startup resync later.

### Changed
- The `messageCreate` relay now captures `msg.attachments` into `ticket_messages.attachments` so audio/files shared in a ticket channel surface on the web.

Closes euphoric-tickets#32.

## [0.5.7] — 2026-05-30 — Bot replies say "team" not "business"

### Changed
- The bot's "This server is not configured as a …" replies now say **team** instead of **business**, matching the web UI rename (web v0.6.8). Display-string only — no schema or identifier change.

## [0.5.6] — 2026-05-30 — Schema mirror: multi-business per guild + attachments

### Changed
- Dropped the unique constraint on `businesses.discord_guild_id` (mirror of web v0.6.7) — a guild can host multiple businesses. The bot still resolves one business per guild for ticket-opening via `getBusinessByGuildId`.

### Added
- `ticket_messages.attachments` jsonb column (mirror) — groundwork for capturing Discord attachments (audio/files) so the web can play them. Populated by the relay + the upcoming `/tickets convert` backfill.

## [0.5.5] — 2026-05-29 — Silent lifecycle status footers

### Added
- **`src/services/ticketStatus.ts`** — `postTicketStatus(channel, text)` posts a small grey `-# ` subtext line into a ticket channel with `MessageFlags.SuppressNotifications` (a "@silent" message — no ping/badge) and `allowedMentions: { parse: [] }` (mentions render as names, never ping). Best-effort: a failed post never breaks the action.
- Wired into lifecycle events:
  - **claim** (in the `claimTicket` service, so both the panel button and `/tickets claim` get it) → `Ticket claimed by <@x>`
  - **unclaim** → `Ticket unclaimed by <@x>`
  - **assign** → `Ticket assigned to <@target> by <@actor>`
  - **add** → `<@target> was added to the ticket by <@actor>`
  - **remove** → `<@target> was removed from the ticket by <@actor>`
  - **rename** → `Channel renamed to \`#…\` by <@actor>`

### Not changed by design
- Bot-side **close** deletes the channel, so no footer is posted there (the opener still receives the close DM + transcript).
- **Internal notes post nothing** to the ticket channel — they stay private to the staff thread. This is a hard rule.

Closes euphoric-tickets#31.

## [0.5.4] — 2026-05-29 — Lantern P2: per-category gates + /tickets delete

### Added — Phase P2 of the lantern plan
- **`src/services/permissions.ts`** — new module with the three-tier helpers (`parseCsv`, `staffRoleIdsForCategory`, `isAdminForBusiness`, `isStaffForCategory`, `canOpenCategory`, `resolveTicketAccess`, `resolveTicketAccessByChannel`). One DB round-trip per resolution; sudo + guild ADMINISTRATOR + business admin roles all map to admin tier.
- **`/tickets delete` slash subcommand** — admin-only hard-delete of a closed ticket's Discord channel. Mirrors the web's Delete button. Refuses on still-open tickets so the close-transcript path always runs once. Nulls the `discord_*` columns the same way `scheduledCleanup.ts` does.

### Changed
- **`openTicket` (`ticketService.ts`)** now refuses panel-button clicks for members whose roles don't intersect `category.allow_role_ids` (when set; empty = anyone), and uses `staffRoleIdsForCategory(business, cat)` for the channel permission overwrites. Per-category override → falls back to `businesses.admin_role_ids` when unset. Existing categories with empty `staff_role_ids` keep the prior behavior.
- **`tickets.ts` command handlers** refactored to share a `loadCtx(interaction)` helper that does business lookup → ticket lookup → per-category access flags. `claim`, `unclaim`, `assign`, `close`, `add`, `remove`, `rename` all now gate via the new flags (`canClaim`, `canClose`, `canManageMembers`). Sudo + admin behavior preserved; category staff is a new tier strictly between opener and admin.

### Behavior change
- Members holding a role only in a category's `staff_role_ids` (not on `businesses.admin_role_ids`) can now run `/tickets claim|unclaim|assign|close|add|remove|rename` on tickets in that category. They cannot run `/tickets delete` — that stays admin-only.

Closes euphoric-tickets#13.

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

`v0.5.16 · 959ed4f`
