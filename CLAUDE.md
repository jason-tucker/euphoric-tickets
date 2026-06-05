# Euphoric Tickets — AI Coding Instructions

See `/home/botuser/projects/claude-all.md` for VPS constraints, Discord.js
patterns, Components V2, and database conventions that apply to all bots.

This bot is **not** a standalone app. It is the Discord half of the Euphoric
Tickets system; the [`euphoric-tickets-web`](https://github.com/jason-tucker/euphoric-tickets-web)
companion is the other half. Both are front-ends over **one shared Postgres
database** — anything you can do on the web you can do here, and vice-versa.
See `README.md` for the full architecture; this file is the working agreement.

---

## Mandatory rules

### 1. Never compile TypeScript on the VPS
`pnpm build` / `pnpm typecheck` / `tsc` OOM the box. Compilation happens in
GitHub Actions; the VPS pulls the pre-built GHCR image. Run `tsc --noEmit`
**locally** before pushing — a type error silently blocks **all** deploys (CI
builds the image, not the VPS). If you suspect a type error, describe it in chat.

### 2. Always update `CHANGELOG.md`
Per-PR semver bump under a dated section. Footer reads `v<x.y.z> · <sha>`. No `[Unreleased]`.

### 3. Every PR or work unit must have a GitHub Projects item
Project board #9 — `Euphoric Tickets`. Add an item before opening the PR.

### 4. The web owns the schema — the bot only connects
Schema lives in `src/db/schema/*.ts` and is **mirrored** from the web repo.
The **web** app runs `drizzle-kit push` on its own container start and is the
single owner of the schema. This bot's `scripts/docker-entrypoint.sh` does
**not** push — it only `exec node dist/index.js` (the push was removed in
0.3.0 to avoid a race over the same tables). No `src/db/migrations/*.sql`
files; no journal. The `db:*` scripts in `package.json` are for local/dev use
only — never run `db:push` against the shared production database.

---

## What this bot does

Euphoric Tickets is a Discord ticket bot: members open support tickets via a
panel button; staff handle them in private channels; every action mirrors to
the web in real time over the shared database (Postgres `LISTEN/NOTIFY`
triggers the web installs — the bot just writes rows).

**Works on any server (auto-provisioning).** When the bot is added to a guild,
a `guildCreate` handler auto-creates a `host` team (`businesses` row) for it —
no manual `/admin business create` needed. On startup it also backfills a row
for every guild it's already in. Both go through `ensureBusinessForGuild` in
`src/services/businessProvision.ts`, which is idempotent (a no-op when the guild
already has at least one team). The server then appears in the unified web
dashboard right away.

**Multi-team.** A single Discord server can host more than one team (a
`businesses` row). Categories, panels and settings resolve per team — by the
channel, the panel message, or the ticket category — so two teams can share a
guild without colliding. `/panel post` and `/tickets settings` take an
optional autocompleted `team:` option. (Auto-provisioning only ever creates the
*first* team for a guild; extra teams are still added by hand / on the web.)

**TicketTool coexistence.** A team can run in `tickettool` mode, where the bot
ingests and controls a third-party TicketTool bot's tickets instead of opening
its own. TicketTool tickets are **never** closed via euphoric's close flow
(which deletes the channel) — they close via TicketTool (`$closeRequest`);
`closeTicket` bails with a reason if `externalSource === 'tickettool'`.

### Ticket lifecycle

1. A server manager (anyone with **Manage Server**, a Ticket Master role, or sudo) runs `/panel post` in a channel. Bot posts a Components V2 panel with one "Open Ticket" button per configured category (staff-only categories never get a panel button).
2. Member clicks a category button → `openTicket()` checks the category's `allow_role_ids`, creates a `ticket-<n>-<username>` channel under the category's Discord parent, denies `@everyone`, grants the opener `ViewChannel`+`SendMessages`, grants each staff role view+manage perms.
3. Bot posts a welcome card in the new channel with **Claim**, **Close**, **Open in web**, and a **Category** select. If the category defines a `first_message_template` it is rendered instead of the default body (placeholders: `{{user}}`, `{{ticketId}}`, `{{subject}}`, `{{category}}`).
4. Conversation flows both ways: Discord messages relay into `ticket_messages`; web replies arrive in-channel via a per-user webhook spoof.
5. Staff claim / unclaim / assign / add / remove / rename / move-category — each posts a small silent `-#` subtext status footer into the channel (`postTicketStatus`) and syncs to the web.
6. Anyone with close perms clicks **Close** (or runs `/tickets close`) → bot renders an HTML transcript, **DMs it to the opener** (best-effort, with a link to the web ticket), then **deletes the ticket channel**. There is no transcript channel and no log channel — see below.

### Close & transcripts (read this carefully)

- Close renders the HTML transcript with `renderTranscriptHtml` (from `fetchAllMessages`) and **DMs it to the opener** as an `.html` attachment, plus a `WEB_BASE_URL/b/<slug>/tickets/<id>` link when the guild maps to a business. The DM is best-effort — silently skipped if the opener has DMs closed or has left the guild. Then `channel.delete()` removes the channel.
- There is **no transcript channel and no log channel.** `getTranscriptChannelId` and `getLogChannelId` in `src/services/settingsService.ts` are **no-ops that return `null`** (the columns don't exist on the web schema). `logTicketEvent` in `src/services/ticketLogger.ts` is likewise a **no-op** that still accepts the event shape so a per-business log channel can be reinstated later in one file without revisiting callsites. Do **not** document or rely on a transcript/log-channel post.
- A web-side close instead *archives* the channel to the team's closed category (`discord_closed_category_id`) so it can be reopened; the bot-side close deletes.

### Configuration lives in DB rows, not a settings table

There is **no `ticket_settings` table.** Config is split across two tables:

- **`businesses`** — one row per team. Columns include `admin_role_ids` (CSV; these are the staff/admin roles the bot reads), `discord_fallback_category_id` (where ticket channels are created by default), `discord_closed_category_id`, `delete_closed_after_days`, `terminology`, `kind` (`host`/`client`), `ticket_mode` (`euphoric`/`tickettool`), `ticket_tool_category_ids`, and a free-form `settings` JSONB.
- **`ticket_categories`** — one row per panel option, scoped to a team by `(business_id, key)`. Columns include `label`, `emoji`, `description`, `sort_order`, `discord_parent_category_id`, `allow_role_ids` (who may open), `staff_role_ids` (who is staff for it), `first_message_template`, `staff_only`, and `kind` (`normal`/`project`).

`/tickets settings` opens a **Manage-Server-gated** ephemeral panel + modal
(anyone with Manage Server / a Ticket Master role / sudo — see the permission
model below) that writes the few **business-level columns the bot still owns**
(`discord_fallback_category_id`,
`admin_role_ids`, `ticket_mode`, `ticket_tool_category_ids`) and can replace the
team's `ticket_categories` rows from a JSON array. Full category management
(per-category roles, templates, parents) lives in the web UI.

**Modal limits.** Discord caps modals at 5 ActionRows × 1 TextInput. Any new
setting beyond that needs a different surface (buttons + selects) — or, better,
the web UI, which owns the richer config.

---

## Commands

| Command | Access | Notes |
|---|---|---|
| `/panel post [team]` | Manage Server | Posts the panel to the current channel; stores message ID in `ticket_panels`. Multi-team servers choose `team:` (autocompleted); one-team servers omit it |
| `/panel refresh [message_id]` | Manage Server | Re-renders an existing panel after settings change (from the panel's own team, falling back to the guild default for older panels) |
| `/tickets settings [team]` | Manage Server | Edit a team's DB-backed config via ephemeral panel + modal. Multi-team servers pick a team with `team:` |
| `/tickets claim` / `/tickets unclaim` | Staff | Take or release the current ticket |
| `/tickets assign <user>` | Staff | Assign the current ticket to a staff member |
| `/tickets close` | Staff or opener | Close the current ticket — DMs the rendered transcript to the opener (best-effort) and **deletes** the channel. No transcript/log channel |
| `/tickets add <user>` | Staff | Add a member to the current ticket (permission overwrite) |
| `/tickets remove <user>` | Staff | Remove a member (the opener cannot be removed — close instead) |
| `/tickets rename <name>` | Staff | Rename the channel; input is slugified, keeps the `ticket-<id>-` prefix |
| `/tickets list` | Staff | List open tickets in the guild (capped at 25 rows, overflow count shown) |
| `/tickets category <key>` | Admin | Move the current ticket to another category |
| `/tickets convert [category] [subject] [opener]` | Admin | Turn the current channel into a ticket and backfill up to 100 recent messages (with attachments) |
| `/tickets delete` | Admin | Hard-delete a closed ticket's channel |
| `/admin sudo grant\|revoke\|list` | Sudo | Manage the sudo flag on user rows from Discord |
| `/admin business create\|list\|delete` | Sudo | Manage team (business) rows |

Slash commands are registered by `src/bot/registerCommands.ts`. CI deploys them
with `node dist/bot/registerCommands.js` inside the built image; locally use
`pnpm commands:deploy`.

### Permission model

`resolveTicketAccess` / `resolveTicketAccessByChannel` in
`src/services/permissions.ts` is the single source of truth; every command
gates through it. On a multi-team server the check resolves the ticket's **own**
team, so staff-role checks and audit attribution use the right team even when it
isn't the guild default.

| Tier | Who | Can |
|---|---|---|
| **admin / sudo** | Discord **Manage Server** (so Administrator + the guild owner too), a "Ticket Master" role in the team's `admin_role_ids`, or a `SUDO_*` role/user | everything, including `delete`, `category`, `convert`, panels + settings |
| **staff** | holds a role in the ticket category's `staff_role_ids` | claim / unclaim / assign / close / add / remove / rename |
| **opener** | opened the ticket | close their own |

`isAdminForBusiness` (Manage Server / Ticket Master / sudo) is the admin gate
for ticket actions; `canManageGuildSettings(member, teams)` is the same check
for the panel + settings surfaces (commands, the Edit button, the modal save).
Both live in `src/services/permissions.ts`.

---

## customId conventions

All ticket interactions are prefixed `tk:` and routed in
`src/bot/events/interactionCreate.ts`:

- `tk:open:{categoryKey}` — panel button
- `tk:claim:{ticketId}` — claim button in the ticket channel
- `tk:close:{ticketId}` — close button in the ticket channel
- `tk:close_confirm:{ticketId}` / `tk:close_cancel:{ticketId}` — close confirmation
- `tk:changecat:{ticketId}` — Category button on the welcome card → opens the category select
- `tk:changecat_sel:{ticketId}` — category select menu
- `tk:settings:{action}` / `tk:settings_modal:{key}` — settings UI

`/tickets add|remove|rename|list|assign|category|convert|delete` and
`/admin …` are slash subcommands rather than buttons — they don't have customIds.

---

## Database tables

Schema is mirrored from the web repo under `src/db/schema/*.ts` and re-exported
from `src/db/schema/index.ts`. **There is no `ticket_settings` table** — config
lives in `businesses` columns + `ticket_categories` rows (see above).

| Table | Purpose |
|---|---|
| `businesses` | One row per team — admin roles, default/closed categories, ticket mode, terminology, settings JSONB |
| `business_members` | Team membership / roles on the web side |
| `ticket_categories` | One row per panel option (per team) — label, emoji, parent category, allow/staff roles, first-message template, staff-only |
| `tickets` | Active and closed tickets — channel ID, opener/claimer/closer user IDs, category ID, status, opened/closed/last-activity timestamps, external source |
| `ticket_messages` | Relayed Discord messages + attachments, deduped by `discord_message_id`; internal-thread messages tagged `source='internal'` |
| `ticket_panels` | One row per panel message (channel ID + message ID + business ID) so `/panel refresh` and panel-open resolution can find it |
| `ticket_external_members` | Extra members added to a ticket (web-tracked) |
| `users` | Discord users known to the system (resolved from Discord IDs) |
| `user_notification_prefs` | Per-user notification preferences (web) |
| `audit_logs` | Per-ticket lifecycle audit rows (open/claim/close/channel_deleted/…) |
| `bot_errors` | Persistent error log written by the bot |
| `app_settings` | Bot-owner global key/value settings (e.g. `bot_name`) — written from the web's Sudo dashboard; the bot reads/applies select keys |

---

## Bot restart (production)

Watchtower auto-pulls the GHCR image; the deploy workflow also SSHes in and
restarts. Manual restart:

```bash
docker compose -f /home/botuser/projects/euphoric-tickets/docker-compose.yml up -d euphoric-tickets
docker compose -f /home/botuser/projects/euphoric-tickets/docker-compose.yml logs -f euphoric-tickets
```

Use `up -d` (not `restart`) after editing `.env` — `restart` does not re-read
the env file. The bot joins the external `efm-public-net` network and talks to
the web stack's `tickets-db` Postgres.

## Deploy slash commands

In CI, the deploy workflow runs `node dist/bot/registerCommands.js` inside the
built image. Locally:

```bash
pnpm commands:deploy
```
