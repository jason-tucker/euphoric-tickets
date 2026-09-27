# Euphoric Tickets

The Discord half of the Euphoric Tickets system — members open support tickets from a panel button, staff handle them in private channels, and every action stays in lock-step with the [`euphoric-tickets-web`](https://github.com/jason-tucker/euphoric-tickets-web) companion over a shared Postgres database.

## Table of contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Stack](#stack)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Usage](#usage)
- [Deployment](#deployment)
- [Conventions](#conventions)

## Overview

Euphoric Tickets is a Discord ticket bot. A member clicks a button on a ticket **panel**, the bot creates a private `ticket-<n>-<user>` channel under the right Discord category, grants the opener plus the relevant staff roles, and posts a welcome card with Claim / Close / Open-in-web / Category controls. Staff then claim, assign, add or remove members, rename, move category, or close — each action posts a small silent `-#` subtext footer into the channel and is mirrored to the web instantly.

It is **not** a standalone app. The bot and the web companion are two front-ends over one Postgres database: anything you can do on the web you can do here, and vice-versa. Discord is the primary end-user surface; the web is the primary staff surface.

Highlights:

- **Auto-provisioning.** The bot works on any server with zero manual setup. A `guildCreate` handler creates a team (`businesses` row) the moment the bot joins a guild, and a startup backfill does the same for every guild it's already in. Both go through the idempotent `ensureBusinessForGuild` — a no-op once a guild has at least one team — so the server shows up in the unified web dashboard immediately, no `/admin business create` required.
- **Multi-team.** A single Discord server can host more than one team (a "business" row). Ticket categories, panels and settings are resolved per team — by the channel, the panel message, or the ticket category — so two teams can share a guild without colliding. `/panel post` and `/tickets settings` take an optional autocompleted `team:` option to target a specific team. (Auto-provisioning only ever creates the first team for a guild; extra teams are still added by hand or on the web.)
- **Lifecycle synced to the web.** Claim, unclaim, assign, add/remove member, rename, close, reopen and change-category all reflect to the web in real time via Postgres triggers the web installs.
- **DM transcript on close.** Closing a ticket renders an HTML transcript, DMs it to the opener (best-effort, with a link to the web ticket), then deletes the channel. There is no dedicated transcript/log channel.
- **Convert + backfill.** `/tickets convert` turns an ordinary channel into a ticket and backfills up to 100 recent messages (with attachments).
- **TicketTool coexistence.** A team can run in `tickettool` mode, where the bot ingests and controls a third-party TicketTool bot's tickets instead of opening its own.
- **Resilient.** Startup resync (orphan scan, panel reconcile, message backfill), a persistent `bot_errors` log, and optional single-leader election for multi-VPS deploys.

## Architecture

The system is one product with two halves over a shared database:

```
Discord  ──▶  euphoric-tickets (this bot)  ─┐
                                            ├─▶  shared Postgres  ◀──  euphoric-tickets-web
Browser  ──▶  euphoric-tickets-web  ────────┘        (web owns the schema)
```

- **Shared Postgres, web owns the schema.** The **web** repo runs `drizzle-kit push` on its own container start and is the single owner of the schema. This bot **mirrors** the same schema files under `src/db/schema/*.ts` and simply connects — its `docker-entrypoint.sh` does **not** push (that was removed to avoid a race over the same tables). Both stacks point `DATABASE_URL` at the same database (`tickets-db` on the shared `efm-public-net` network).
- **Message relay.** `messageCreate` writes Discord messages and attachments into `ticket_messages`, deduplicated by `discord_message_id`. Internal-thread messages are tagged `source='internal'` and stay staff-private. Embeds (TicketTool cards/logs) are flattened to text and archived too.
- **Internal HTTP bridge.** The bot runs a tiny HTTP server (`INTERNAL_PORT`, default 8787) authed by `x-internal-token` matching `INTERNAL_TOKEN` (constant-time compare), exposing `POST /api/internal/dm` (DM a user through the gateway), `POST /api/internal/tickettool/{command,reconcile,reprocess-embeds}` (TicketTool coexistence), `POST /api/internal/{guild/leave,bot/username}` (bot-owner Sudo dashboard controls), and the **Integration API** routes `POST /api/internal/tickets/{open,close,webhook/ensure}` (see below). The bot in turn calls the web's `/api/internal/notify` (on `WEB_INTERNAL_URL`, falling back to `WEB_BASE_URL`) to fan out notifications for Discord-origin events. When `INTERNAL_TOKEN` is unset the server still starts and falls back to authenticating with `DISCORD_BOT_TOKEN` (logging a loud startup warning) rather than disabling — set a dedicated `INTERNAL_TOKEN` (matching the web app) to avoid reusing the bot token as an HTTP secret.
- **Integration API (bot half).** External services (first: the EFM Music Portal) open tickets on behalf of a Discord user through the web's public `/api/v1/tickets`, which authenticates the integration key and calls the bot's internal routes. The business is always passed **by id** (several teams can share a guild). `open` takes an idempotency claim in `integration_open_claims` on `(integration_id, external_ref)` — adopting an existing ticket, answering `409 opening_in_progress` while another open is in flight, or taking over a stale (≥ 2 min) / failed claim and deleting its orphan channel — then runs the normal `openTicket` flow with `source:'integration'`: per-staff-role overwrites, a mandatory channel webhook, the welcome card with the integration's card lines + a link button (same `tk:*` buttons), role pings, notify and audit (`via='integration:<slug>'`). `close` closes as the actor when they hold a category-staff, team-staff (`businesses.staff_role_ids`) or team-admin role — the same role-only set the web's `checkActor` uses, without Manage Server or sudo — else as the bot, and reports which in `closedBy`. Every route re-checks the integration binding against the mirrored `integrations` row (enabled, same business, allowlisted category, ticket owned by the integration); `close` and `webhook/ensure` therefore require `integrationId`. Only Discord `10003 Unknown Channel` counts as a vanished channel — transient errors answer `503` and change nothing. Adopting a ticket whose channel was cleaned up answers `409 ticket_channel_missing`. The full request/response table is in `CLAUDE.md` ("Integration route contract"). Categories flagged `integration_only` can only be opened this way — panels never show them and stale buttons / `/tickets convert` are refused.
- **Live web refresh** is driven by Postgres `LISTEN/NOTIFY` triggers the web installs — the bot just writes rows; the web reacts.

Configuration lives in database rows, not a settings table:

- **`businesses`** — one row per team. Columns include `admin_role_ids` (CSV), `discord_fallback_category_id`, `discord_closed_category_id`, `delete_closed_after_days`, `ticket_mode` (`euphoric`/`tickettool`), `ticket_tool_category_ids`, and a free-form `settings` JSONB.
- **`ticket_categories`** — one row per panel option, scoped to a team by `(business_id, key)`. Columns include `label`, `emoji`, `description`, `sort_order`, `discord_parent_category_id`, `allow_role_ids` (who may open), `staff_role_ids` (who is staff for it), `first_message_template`, `staff_only`, `integration_only`, and `kind` (`normal`/`project`).

Full table list: `businesses`, `ticket_categories`, `tickets`, `ticket_messages`, `ticket_panels`, `users`, `business_members`, `audit_logs`, `bot_errors`, `user_notification_prefs`, `ticket_external_members`, `integrations` (read-only mirror; the web manages them), `integration_open_claims` (Integration API open idempotency), `app_settings` (bot-owner global key/value settings, e.g. `bot_name`, written from the web's Sudo dashboard). (There is **no** `ticket_settings` table.)

## Stack

- **TypeScript** on **Node 24**, **discord.js v14** (Components V2)
- **Postgres** via **Drizzle ORM** (schema mirrored from the web repo; the web owns `drizzle-kit push`)
- Tiny internal HTTP server for the web ↔ bot DM/notify bridge
- **Zod** for environment validation (`src/config/env.ts`)
- **pnpm 10**, Docker multi-stage build, GHCR + watchtower auto-deploy

## Quick start

Requires Node 24, pnpm 10, and access to the shared Postgres (or a local one). Remember: the **web** app owns the schema and runs `drizzle-kit push` — this bot does not push, it only connects to a database whose schema already exists.

```bash
pnpm install

# Configure — see the Configuration table for every variable.
cp .env.example .env
# Set at minimum: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, GUILD_ID, DATABASE_URL

# Register slash commands against your guild.
pnpm commands:deploy

# Run in watch mode.
pnpm dev
```

If you are bringing up a brand-new database, run the web app's schema push first (or stand up the whole system via the web repo's combined compose file); then point this bot's `DATABASE_URL` at it.

Useful scripts (`package.json`): `pnpm dev` (tsx watch), `pnpm build` / `pnpm start` (compiled), `pnpm typecheck`, `pnpm test` / `pnpm test:docker` (vitest suite against a throwaway Postgres — see below), `pnpm commands:deploy` / `pnpm commands:clear`, and the `db:*` drizzle helpers (`db:push` is refused unless `ALLOW_BOT_SCHEMA_PUSH=1`, for a throwaway database only — the schema is owned by the web, and the web-only tables are filtered out so a bot push can never drop them).

**Tests.** `pnpm test:docker` runs typecheck, build and the vitest suite inside `node:24-alpine` against a throwaway `postgres:16-alpine` on a private Docker network (both removed afterwards). The suite pushes this repo's schema mirror into that database and drives the ticket code with mocked discord.js objects (`test/fakes.ts`) — no Discord token or real database is involved. `pnpm test` alone needs `TEST_DATABASE_URL` pointing at a throwaway database.

## Configuration

Environment variables, derived from `src/config/env.ts` (plus `LEADER_ELECTION`, read directly via `process.env`, and the optional build-stamp vars). Empty strings for the optional keys are coerced to "unset" so an unfilled `.env` line won't crash startup.

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token. |
| `DISCORD_CLIENT_ID` | Yes | Application (client) ID — a Discord snowflake. |
| `GUILD_ID` | Yes | Primary guild used for slash-command registration — a snowflake. |
| `DATABASE_URL` | Yes | Connection string for the **shared** Postgres owned by the web app. |
| `NODE_ENV` | No | `development` \| `production` \| `test`. Default `development`. |
| `WEB_BASE_URL` | No | Public URL of the web companion, used in every link shown to people (close DMs, welcome cards). Also the notify-bridge fallback when `WEB_INTERNAL_URL` is unset. Default `https://tickets.euphoric.fm`. |
| `WEB_INTERNAL_URL` | No | Private-network URL of the web companion (e.g. `http://tickets-web:3000`) for bot → web server-to-server calls (the notify bridge), so they stay on the Docker network. Unset = use `WEB_BASE_URL`. |
| `INTERNAL_TOKEN` | No | Shared secret (min 8 chars) authenticating the web ↔ bot internal endpoints. When unset, the internal HTTP server still starts but falls back to `DISCORD_BOT_TOKEN` as the auth secret (logging a startup warning) — set a dedicated value here and on the web app to avoid reusing the bot token as an HTTP secret. |
| `INTERNAL_PORT` | No | Port for the bot's internal DM/HTTP server. Default `8787`. |
| `SUDO_ROLE_IDS` | No | Comma-separated role snowflakes treated as bot owners everywhere. |
| `SUDO_USER_IDS` | No | Comma-separated user snowflakes treated as bot owners everywhere. |
| `BOT_OWNER_ID` | No | User snowflake that receives a startup "bot is up" DM. |
| `UPTIME_KUMA_PUSH_URL` | No | Uptime Kuma push URL for health heartbeats. |
| `LEADER_ELECTION` | No | Set to `off` to skip the Postgres advisory-lock leader wait on single-VPS deploys (read via `process.env`, not the Zod schema). |
| `POSTGRES_PASSWORD` | compose | Used by `docker-compose.yml` to build `DATABASE_URL` for the shared DB; must match the web stack. |
| `GIT_SHA` / `SOURCE_COMMIT` | No | Optional build SHA shown in the startup DM and version footer. |

## Usage

### Commands

| Command | Access | What it does |
|---|---|---|
| `/panel post [team]` | Manage Server / Ticket Master / sudo | Post a Components V2 ticket panel in this channel. On a multi-team server, choose which team's panel (autocompleted); one-team servers can omit it. |
| `/panel refresh [message_id]` | Manage Server / Ticket Master / sudo | Re-render an existing panel after a settings change (from the panel's own team, falling back to the guild default for older panels). |
| `/tickets settings [team]` | Manage Server / Ticket Master / sudo | View/edit a team's DB-backed config via an ephemeral panel + modal. Multi-team servers pick a team with `team:` (or get a slug list). |
| `/tickets claim` / `/tickets unclaim` | staff | Take or release the current ticket. |
| `/tickets assign <user>` | staff | Assign the current ticket to a staff member. |
| `/tickets close` | staff / opener | Close the current ticket (DMs the transcript to the opener, then deletes the channel). |
| `/tickets add <user>` / `/tickets remove <user>` | staff | Add or remove a member from the current ticket. The opener can't be removed (close instead). |
| `/tickets rename <name>` | staff | Rename the channel (slugified, keeps the `ticket-<id>-` prefix). |
| `/tickets list` | staff | List open tickets in the guild (capped at 25 rows; overflow count shown). |
| `/tickets category <key>` | admin | Move the current ticket to another category. |
| `/tickets convert [category] [subject] [opener]` | admin | Turn this channel into a ticket and backfill up to 100 recent messages. |
| `/tickets delete` | admin | Hard-delete a closed ticket's channel. |
| `/admin sudo grant\|revoke\|list` | sudo | Manage the sudo flag on user rows from Discord. |
| `/admin business create\|list\|delete` | sudo | Manage team (business) rows — create a team, list, or delete. |

The welcome-card buttons mirror the in-channel controls: Claim, Close, Open in web, and a category select.

### Permission model

`resolveTicketAccess` / `resolveTicketAccessByChannel` in `src/services/permissions.ts` is the single source of truth; every command gates through it. On a multi-team server the check resolves the ticket's **own** team, so staff-role checks and audit attribution use the right team even when it isn't the guild default.

| Tier | Who | Can |
|---|---|---|
| **admin / sudo** | Discord **Manage Server** (which subsumes Administrator + the guild owner), a role in the team's `admin_role_ids` ("Ticket Master"), or a `SUDO_*` role/user | everything, including `/tickets delete`, `/tickets category`, `/tickets convert`, and settings |
| **staff** | holds a role in the ticket category's `staff_role_ids` | claim / unclaim / assign / close / add / remove / rename |
| **opener** | opened the ticket | close their own |

### Ticket lifecycle

1. A member clicks a panel button → `openTicket()` checks the category's `allow_role_ids`, creates the private channel under the category's Discord parent, grants the opener + staff overwrites, and posts the welcome card. If the category defines a `first_message_template` it is rendered instead of the default body (placeholders: `{{user}}`, `{{ticketId}}`, `{{subject}}`, `{{category}}`).
2. Conversation flows both ways: Discord messages relay into `ticket_messages`; web replies arrive in-channel via a per-user webhook spoof.
3. Staff claim / assign / add people / move category / rename — each posts a silent status footer and syncs to the web.
4. **Close** renders the HTML transcript, DMs it to the opener with a link to the web ticket (best-effort — silently skipped if their DMs are closed or they've left), then **deletes** the channel. (A web-side close instead *archives* the channel to the closed category so it can be reopened.) There is no transcript channel: `getTranscriptChannelId` / `getLogChannelId` are no-ops because the column no longer exists on the web schema.

### Interaction customIds

Buttons, selects and modals are routed by a `tk:` customId prefix in `src/bot/events/interactionCreate.ts`: `tk:open:{categoryKey}`, `tk:claim:{ticketId}`, `tk:close:{ticketId}`, `tk:close_confirm:{ticketId}`, `tk:close_cancel:{ticketId}`, `tk:changecat:{ticketId}`, `tk:changecat_sel:{ticketId}`, `tk:settings:edit:{teamSlug}`, `tk:settings:togglemode:{teamSlug}`, `tk:settings_modal:{teamSlug}`.

## Deployment

Deploys are automatic. The flow (`.github/workflows/deploy.yml`):

1. Push to `main` → GitHub Actions builds the multi-stage Docker image (TypeScript is compiled in CI, never on the VPS) and pushes it to GHCR.
2. The workflow deploys slash commands against Discord (`node dist/bot/registerCommands.js`).
3. It SSHes to the VPS, `git reset --hard origin/main`, then pulls and restarts the container; watchtower also auto-pulls on its own poll cycle as a backstop.

The bot runs from `docker-compose.yml`, joining the external `efm-public-net` network and talking to the web stack's `tickets-db` Postgres.

```bash
# Bring the bot up / apply an image or compose change:
docker compose up -d

# After editing .env (restart alone does NOT re-read it):
docker compose up -d
```

Stand up the whole system (Postgres + web + bot) in one go via the web repo's combined compose file.

## Conventions

- **Never** run `tsc` / `pnpm build` / `pnpm typecheck` on the VPS — it OOMs the box. CI compiles; the VPS pulls the prebuilt GHCR image. A type error silently blocks **all** deploys (CI builds the image), so run a typecheck locally before pushing.
- **CHANGELOG.** Every PR bumps a real semver under a dated section (no `[Unreleased]`); the footer reads `v<x.y.z> · <sha>`.
- **Project board.** Every PR or work unit gets an item on GitHub Projects board #9 (`Euphoric Tickets`) before the PR opens.
- **Schema is owned by the web.** Edit schema in `src/db/schema/*.ts` to mirror the web repo, but the **web** app runs `drizzle-kit push`; this bot only connects. There are no SQL migration files. Mirror new web columns on shared tables exactly (a bot push against a web-pushed DB must print `No changes detected`).
- **Web → Discord user content** goes via the per-user webhook spoof; the bot only posts system content (welcome card, status footers, transcripts).
- See `CLAUDE.md` for the full working agreement and `CHANGELOG.md` for the per-release history.
