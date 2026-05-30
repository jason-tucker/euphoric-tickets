# Euphoric Tickets — Discord bot

The Discord half of the Euphoric Tickets system. This bot and the
[`euphoric-tickets-web`](https://github.com/jason-tucker/euphoric-tickets-web)
app are **one system with two front-ends** sharing a single Postgres database —
everything you can do on the web you can do here, and vice-versa. Discord is the
primary end-user surface; the web is the primary staff surface.

---

## Table of contents

- [What it does](#what-it-does)
- [How the two halves fit together](#how-the-two-halves-fit-together)
- [Permission model](#permission-model)
- [Slash commands](#slash-commands)
- [The ticket lifecycle](#the-ticket-lifecycle)
- [Resilience](#resilience)
- [Stack](#stack)
- [Local development](#local-development)
- [Production](#production)
- [Environment variables](#environment-variables)
- [Conventions](#conventions)

---

## What it does

- **Ticket panels.** `/panel post` drops a Components V2 panel with one button
  per configured category. A member clicks → the bot creates a private
  `ticket-<n>-<user>` channel under the category's Discord parent, grants the
  opener + staff roles, and posts a **welcome card**: compact info header,
  the ticket reason as the dominant body (or a per-category **custom
  first-message template**), and Claim / Close / Open-in-web / Category buttons.
- **Per-category gating.** `allow_role_ids` decide who may open a category;
  `staff_role_ids` decide who is *staff* for it (a tier below admin).
- **Lifecycle, fully synced to the web.** Claim, unclaim, assign, add/remove
  member, rename, close, reopen, change-category — each posts a small **silent
  `-#` subtext footer** into the channel (e.g. `-# Ticket claimed by @x`) and is
  reflected on the web instantly. Internal notes never post to the channel.
- **Convert existing channels.** `/tickets convert` turns a normal channel into
  a ticket and **backfills up to 100 recent messages** (with attachments).
- **Attachment capture.** Audio/files shared in a ticket channel are captured so
  the web can play/download them (streamed from Discord's CDN).
- **DM gateway.** If a user DMs the bot, it explains (once per 10 min) that DMs
  don't reach staff and points them at the panel / web.
- **Notifications.** New tickets and replies trigger ntfy/DM fan-out via the
  web dispatcher; the bot also serves DMs the web asks it to send.

---

## How the two halves fit together

- **Shared Postgres.** The web repo **owns the schema** (`drizzle-kit push`);
  this repo mirrors the schema files. The bot's `DATABASE_URL` points at the
  same database.
- **Relay.** `messageCreate` writes Discord messages + attachments into
  `ticket_messages`, dedup'd by `discord_message_id`. Internal-thread messages
  are tagged `source='internal'` and stay staff-private.
- **Internal HTTP.** The bot runs a tiny server (`INTERNAL_PORT`, default 8787)
  exposing `POST /api/internal/dm`, authed by `INTERNAL_TOKEN`, so the web can
  DM a user through the gateway. The bot calls the web's `/api/internal/notify`
  to trigger notification fan-out on Discord-origin events.
- **Live web refresh** is driven by Postgres `LISTEN/NOTIFY` triggers the web
  installs — the bot just writes rows; the web reacts.

---

## Permission model

| Tier | Who | Can |
|---|---|---|
| **admin / sudo** | guild ADMINISTRATOR, in `admin_role_ids`, or `SUDO_*` | everything, incl. **`/tickets delete`** + change category + settings |
| **staff** | holds a role in the ticket category's `staff_role_ids` | claim / unclaim / assign / close / add / remove / rename |
| **opener** | opened the ticket | close their own |

`resolveTicketAccess` in `src/services/permissions.ts` is the single source of
truth; every command gates through it.

---

## Slash commands

| Command | Access | What it does |
|---|---|---|
| `/panel post` | sudo | Post the ticket panel here |
| `/panel refresh` | sudo | Re-render an existing panel |
| `/tickets settings` | sudo | DB-backed config (category, staff roles, panel JSON) |
| `/tickets claim` / `unclaim` | staff | Take / release the current ticket |
| `/tickets assign <user>` | staff | Assign to a staff member |
| `/tickets close` | staff / opener | Close (transcript → opener DM, channel deleted) |
| `/tickets add <user>` / `remove <user>` | staff | Manage ticket membership |
| `/tickets rename <name>` | staff | Rename the channel (slugified, keeps `ticket-<id>-`) |
| `/tickets category <key>` | **admin** | Move the ticket to another category |
| `/tickets convert [category] [subject] [opener]` | **admin** | Turn this channel into a ticket + backfill history |
| `/tickets delete` | **admin** | Hard-delete a closed ticket's channel |
| `/tickets list` | staff | List open tickets in the guild |
| `/admin sudo …` / `/admin business …` | sudo | Manage sudo + teams from Discord |

Ticket controls also exist as buttons on the welcome card (Claim, Close, Open
in web, 🗂️ Category select).

---

## The ticket lifecycle

1. Member clicks a panel button → `openTicket()` checks `allow_role_ids`,
   creates the channel, grants staff overwrites, posts the welcome card.
2. Conversation flows both ways: Discord messages relay to the web; web replies
   arrive via the per-ticket webhook (spoofed as the replying staffer).
3. Staff claim / assign / add people / move category — each posts a status
   footer and syncs to the web.
4. Close renders an HTML transcript, DMs it to the opener with a web link, and
   deletes the channel (web-side close instead *archives* the channel to the
   closed category so it can be reopened).

---

## Resilience

- **Startup resync** (`src/bot/startupResync.ts`) runs on every connect:
  orphaned-channel scan (flags `needs_attention`), panel reconcile, and
  **message backfill** of anything posted while the bot was offline — all
  best-effort, in bounded-concurrency batches, never blocking boot.
- **Persistent error log.** `persistError()` writes structured rows to
  `bot_errors` (5-day retention, swept hourly); a sudo page on the web renders
  the tail.
- **Single-leader** (`src/bot/leader.ts`). On multi-VPS, every instance tries a
  Postgres advisory lock before connecting; only the leader runs the gateway,
  failover ~30 s. `LEADER_ELECTION=off` skips this on a single VPS.

---

## Stack

- **TypeScript + discord.js v14**, Components V2
- **Postgres + Drizzle ORM** (`drizzle-kit push` at container start — no SQL
  migration files; schema mirrored from the web repo)
- Tiny internal HTTP server for web↔bot DM dispatch
- Docker + GHCR build (CI compiles; never `tsc` on the VPS) · watchtower
- pnpm 10 · Node 24

---

## Local development

```bash
pnpm install
cp .env.example .env   # DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, GUILD_ID, SUDO_USER_IDS, DATABASE_URL
docker compose up -d db
pnpm db:push
pnpm commands:deploy   # register slash commands
pnpm dev
```

---

## Production

```bash
git clone https://github.com/jason-tucker/euphoric-tickets ~/projects/euphoric-tickets
cd ~/projects/euphoric-tickets
cp .env.example .env && nano .env          # DATABASE_URL → the shared web Postgres
docker compose up -d
```

Or stand up the **whole system** (Postgres + web + bot) in one command with the
web repo's `docker-compose.combined.yml`.

Subsequent deploys are automatic: push to `main` → GitHub Actions builds →
GHCR → watchtower pulls and restarts (~60–90 s).

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Yes | Bot token |
| `DISCORD_CLIENT_ID` | Yes | Application ID |
| `GUILD_ID` | Yes | Primary guild (command registration) |
| `DATABASE_URL` | Yes | Points at the **shared** web Postgres |
| `WEB_BASE_URL` | Rec. | Web app URL (close-DM links, notify bridge). Default `https://tickets.euphoric.fm` |
| `INTERNAL_TOKEN` | Rec. | Shared secret for the web↔bot internal endpoints |
| `INTERNAL_PORT` | No | Port for the bot's internal DM server (default 8787) |
| `LEADER_ELECTION` | No | `off` to skip the advisory-lock wait on single-VPS deploys |
| `SUDO_ROLE_IDS` / `SUDO_USER_IDS` | No | Comma-separated bot-admin roles/users |
| `BOT_OWNER_ID` | No | Receives a startup DM |
| `UPTIME_KUMA_PUSH_URL` | No | Health-push monitor |
| `POSTGRES_PASSWORD` | compose | Postgres password |

---

## Conventions

- **Never** run `tsc` / `pnpm build` on the VPS — CI compiles; the box pulls the
  image.
- Schema lives in `src/db/schema/*.ts`, mirrored from the web repo; the
  entrypoint pushes it. No SQL migration files.
- Web → Discord user content goes via the per-user webhook spoof; the bot only
  posts system content (welcome card, status footers, transcripts).
- See `CLAUDE.md` for the working agreement and `CHANGELOG.md` for the
  per-release history (the system is at the lantern milestone P1–P19).

`euphoric-tickets v0.5.17`
