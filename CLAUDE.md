# Euphoric Tickets — AI Coding Instructions

See `/home/botuser/projects/claude-all.md` for VPS constraints, systemd setup,
Discord.js patterns, Components V2, and database conventions that apply to all bots.

---

## Mandatory rules

### 1. Never compile TypeScript on the VPS
`pnpm build` / `pnpm typecheck` / `tsc` OOM the box. Compilation happens in GitHub Actions; the VPS pulls the pre-built GHCR image. If you suspect a type error, describe it in chat.

### 2. Always update `CHANGELOG.md`
Per-PR semver bump under a dated section. Footer reads `v<x.y.z> · <sha>`. No `[Unreleased]`.

### 3. Every PR or work unit must have a GitHub Projects item
Project board #9 — `Euphoric Tickets`. Add an item before opening the PR.

### 4. `drizzle-kit push` — no SQL migrations
Schema lives in `src/db/schema/*.ts`. The Docker entrypoint runs `drizzle-kit push --force` against the compiled `dist/db/schema/index.js`. No `src/db/migrations/*.sql` files; no journal to keep in sync.

---

## What this bot does

Euphoric Tickets is a single-purpose Discord bot: members open support tickets via a panel button; staff handle them in private channels.

### Ticket lifecycle

1. Sudo runs `/panel post` in a channel. Bot posts a Components V2 panel with one "Open Ticket" button per configured category.
2. Member clicks a category button → bot creates `ticket-<n>-<username>` channel under the tickets category, denies `@everyone`, grants the opener `ViewChannel`+`SendMessages`, grants each staff role view+manage perms.
3. Bot posts a welcome card in the new channel with **Claim**, **Close** buttons. Pings configured staff roles once.
4. Staff clicks **Claim** → ticket marked claimed, claimer name appended to the welcome card.
5. Anyone with close perms clicks **Close** (or runs `/tickets close`) → bot fetches the full message history, renders an HTML transcript, posts the file to the configured transcript channel, then deletes the ticket channel.

### Settings

`/tickets settings` opens a sudo-only ephemeral panel. Each setting is a row in `ticket_settings` keyed by string. Editable:

- `tickets.category_id` — Discord category where ticket channels are created
- `tickets.transcript_channel_id` — where closed-ticket HTML files land
- `tickets.log_channel_id` — where lifecycle events (open/claim/close/add/remove/rename) post CV2 cards
- `tickets.staff_role_ids` — comma-separated; these roles see every ticket and can claim/close
- `tickets.panel_categories` — JSON array of `{ key, label, emoji, description }` driving the panel buttons

**Modal limits.** Discord caps modals at 5 ActionRows × 1 TextInput. We're at 5; any new setting needs a different surface (e.g. a buttons + selects panel) instead of being added to the modal.

---

## Commands

| Command | Access | Notes |
|---|---|---|
| `/panel post` | Sudo | Posts the panel to the current channel; stores message ID in `ticket_panels` |
| `/panel refresh` | Sudo | Re-renders an existing panel after settings change |
| `/tickets settings` | Sudo | Edit settings via ephemeral panel (5-field modal: category, transcript, log, staff, panel JSON) |
| `/tickets claim` | Staff | Claim the current ticket (only in a ticket channel) |
| `/tickets close` | Staff or opener | Close the current ticket — saves transcript to log/transcript channel AND DMs opener (best-effort), deletes channel |
| `/tickets add <user>` | Staff | Add a member to the current ticket (permission overwrite) |
| `/tickets remove <user>` | Staff | Remove a member from the current ticket (opener cannot be removed — close instead) |
| `/tickets rename <name>` | Staff | Rename the current ticket channel; input is slugified, prefixed with `ticket-<id>-` |
| `/tickets list` | Staff | List every open ticket in the guild (capped at 25 rows, overflow shown) |

---

## customId conventions

All ticket interactions are prefixed `tk:`:

- `tk:open:{categoryKey}` — panel button
- `tk:claim:{ticketId}` — claim button in the ticket channel
- `tk:close:{ticketId}` — close button in the ticket channel
- `tk:close_confirm:{ticketId}` / `tk:close_cancel:{ticketId}` — close confirmation
- `tk:settings:{action}` / `tk:settings_modal:{key}` — settings UI

`/tickets add|remove|rename|list` are slash subcommands rather than buttons — they don't have customIds.

---

## Database tables

| Table | Purpose |
|---|---|
| `ticket_settings` | Key/value config edited via `/tickets settings` |
| `ticket_panels` | One row per panel message (channel ID + message ID) so `/panel refresh` can find it |
| `tickets` | Active and closed tickets — channel ID, opener ID, category key, claimer ID, status, opened/closed timestamps |

---

### Ticket lifecycle (extended)

After v0.2.0, every open / claim / close / add-member / remove-member / rename emits a Components V2 card to `tickets.log_channel_id` if set. Closes also DM the rendered HTML transcript to the opener best-effort (silent on DM-closed / left-guild). The same `renderTranscriptHtml` buffer is used for both the log-channel post and the opener DM — don't re-fetch channel messages twice.

`/tickets add` and `/tickets remove` edit channel permission overwrites directly. The opener's overwrite is set up at ticket creation and cannot be removed via `/tickets remove` (closes the ticket instead via `/tickets close`).

`/tickets rename` slugifies the input (`[a-z0-9-]`) and always preserves `ticket-<id>-` as the prefix so ticket numbers stay searchable.

---

## Bot restart (production)

Watchtower auto-pulls; manual restart:

```bash
docker compose -f /home/botuser/projects/euphoric-tickets/docker-compose.yml restart euphoric-tickets
docker compose -f /home/botuser/projects/euphoric-tickets/docker-compose.yml logs -f euphoric-tickets
```

## Deploy slash commands

In CI, the deploy workflow runs `node dist/bot/registerCommands.js` inside the built image. Locally:

```bash
pnpm commands:deploy
```
