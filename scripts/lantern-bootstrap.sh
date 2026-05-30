#!/usr/bin/env bash
# lantern-bootstrap.sh — STEP 0 of /home/botuser/.claude/plans/valiant-tinkering-lantern.md
#
# Creates one GitHub issue per phase (cross-repo phases get one per side) and
# adds each to the correct user-scoped project board:
#   - Bot board #9  (jason-tucker/euphoric-tickets)
#   - Web board #10 (jason-tucker/euphoric-tickets-web)
#
# Idempotent: if an issue with the same title already exists in the target
# repo it's reused (the existing issue gets re-added to the board, which gh
# treats as a no-op if it's already on the board).
#
# Run from anywhere; gh's --repo flag pins the target.
#
# Usage:   bash scripts/lantern-bootstrap.sh
# Re-run:  safe — same titles → same issues → same project items.

set -euo pipefail

REPO_BOT='jason-tucker/euphoric-tickets'
REPO_WEB='jason-tucker/euphoric-tickets-web'
BOARD_BOT=9
BOARD_WEB=10
OWNER='@me'

# Counter file so subshells can write through (the `url=$(create_…)` capture
# would otherwise eat any variable increment inside the function).
COUNTERS=$(mktemp)
printf 'CREATED=0\nEXISTING=0\nADDED=0\n' > "$COUNTERS"
bump() { local k="$1"; local n; n=$(grep "^$k=" "$COUNTERS" | cut -d= -f2); echo "$k=$((n+1))" > /tmp/.b; sed -i "s/^$k=.*$/$(cat /tmp/.b)/" "$COUNTERS"; }

# Cache the full open+closed issue list per repo so we hit the API once instead
# of once per phase. Filter for exact-title match via jq with --arg (the v1
# attempt at gh's --search was unreliable for titles with em-dashes / quotes).
ISSUE_CACHE_DIR=$(mktemp -d)
trap 'rm -rf "$ISSUE_CACHE_DIR" "$COUNTERS" /tmp/.b' EXIT

repo_issues_cache() {
  local repo="$1"
  local cache="$ISSUE_CACHE_DIR/${repo//\//__}.json"
  if [[ ! -f "$cache" ]]; then
    # Only OPEN issues — closed dupes (e.g. from a botched earlier run) would
    # otherwise be picked as "canonical" and re-added to the board.
    gh issue list --repo "$repo" --state open --limit 200 --json title,url > "$cache"
  fi
  echo "$cache"
}

# create_or_get_issue REPO TITLE BODY → prints the issue URL
create_or_get_issue() {
  local repo="$1" title="$2" body="$3"
  local cache
  cache=$(repo_issues_cache "$repo")
  local existing_url
  existing_url=$(jq -r --arg t "$title" '.[] | select(.title == $t) | .url' "$cache" | head -n1)
  if [[ -n "$existing_url" ]]; then
    bump EXISTING
    echo "$existing_url"
    return 0
  fi
  local new_url
  new_url=$(gh issue create --repo "$repo" --title "$title" --body "$body")
  # Append the freshly-created issue to the cache so subsequent calls in the
  # same run see it (jq -c -n keeps the file as a JSON array).
  jq --arg t "$title" --arg u "$new_url" '. + [{title: $t, url: $u}]' "$cache" > "$cache.new" && mv "$cache.new" "$cache"
  bump CREATED
  echo "$new_url"
}

add_to_board() {
  local board="$1" url="$2"
  if gh project item-add "$board" --owner "$OWNER" --url "$url" >/dev/null 2>&1; then
    bump ADDED
  fi
}

mk() {
  # mk BOARD REPO TITLE BODY
  local board="$1" repo="$2" title="$3" body="$4"
  local url
  url=$(create_or_get_issue "$repo" "$title" "$body")
  add_to_board "$board" "$url"
  printf '  %-12s %s\n' "[#$board]" "$url"
}

echo '== Lantern plan bootstrap =='
echo 'Creating/refreshing issues + adding to project boards…'
echo

# ---- M1 ---------------------------------------------------------------------
mk $BOARD_WEB $REPO_WEB \
  'P1 — Per-category role columns + edit-category form' \
  'Phase P1 of the lantern plan.

Schema: add `allow_role_ids text NOT NULL DEFAULT '"''"'`, `staff_role_ids text NOT NULL DEFAULT '"''"'`, `first_message_template text NULL` to `ticket_categories` (mirror on the bot side in a separate bot-board issue if needed).

Settings page: each category row becomes an editable `<form>` with `updateCategoryAction(slug, categoryId, formData)` mirroring `addCategoryAction`. Snowflake fields use the P3 picker once available (plain `<input>` is the graceful fallback until then).

No bot-side editor change.'

mk $BOARD_BOT $REPO_BOT \
  'P2 — Bot enforces per-category roles + adds /tickets delete (admin-only)' \
  'Phase P2 (bot half) of the lantern plan.

`tk:open:<categoryKey>` handler: if `category.allowRoleIds` non-empty, intersect with `interaction.member.roles.cache`; empty → ephemeral denial.

`openTicket` service: `staffRoleIds = parseCsv(category.staffRoleIds) || parseCsv(business.adminRoleIds)`.

New helper `src/services/permissions.ts` mirroring the web `resolveTicketAccess` shape. Every handler in `src/commands/tickets.ts` calls it. New `/tickets delete` slash command admin-only. Welcome-card `Delete channel` button (P4) hidden unless admin, server-side rejection as defense-in-depth.'

mk $BOARD_WEB $REPO_WEB \
  'P2 — resolveTicketAccess helper + three-tier permission gates on web' \
  'Phase P2 (web half) of the lantern plan.

New `resolveTicketAccess(slug, ticketId, session)` in `src/server/permissions.ts` returning `{ canSee, canReply, canClaim, canClose, canChangeCategory, canManageMembers, canDeleteChannel }`.

Replace every scattered `isAdmin && …` in `/b/[slug]/tickets/[id]/page.tsx` + `actions.ts` with the new helper. Mapping table:

| Action | Tier |
| --- | --- |
| see / reply | opener OR staff-on-category OR admin |
| claim / unclaim / close / reopen / members / internal note | staff-on-category OR admin |
| change category / delete channel / edit settings | admin only |

Denials log to P12 `bot_errors` at `level=info` for audit.'

# ---- M2 ---------------------------------------------------------------------
mk $BOARD_WEB $REPO_WEB \
  'P3 — Discord directory picker (channels/roles/members, accepts raw ID, per-keystroke)' \
  'Phase P3 of the lantern plan.

Deps: `cmdk`, `@radix-ui/react-popover`.

3 Discord helpers in `src/lib/discord.ts`: `fetchGuildChannels`, `fetchGuildRoles`, `fetchGuildMembers(query?)` (uses members/search when q set).

3 thin API routes under `src/app/api/discord/[guildId]/{channels,roles,members}/route.ts`. `requireBusinessAccess(..., '"'"'admin'"'"')` gate. 60s in-process cache for channels/roles.

`src/components/app/discord-picker.tsx` (`'"'"'use client'"'"'`) — single input filters + accepts raw snowflake on paste/Enter; cmdk list filters per-character (80ms debounce for members). Hidden CSV input for form submission.

Used by: P1 settings, P6 members card, P10 mention-resolve, P16 external-add.'

# ---- M3 ---------------------------------------------------------------------
mk $BOARD_BOT $REPO_BOT \
  'P4 — Custom first-message template + Components V2 welcome-card redesign' \
  'Phase P4 of the lantern plan.

Bot reads `category.firstMessageTemplate` (schema added in P1) and substitutes `{{user}}`, `{{ticketId}}`, `{{subject}}`, `{{category}}`. Null/empty → default card.

Restructure `buildTicketWelcome()`:
- Top Section: compact ticket # + category emoji+label + opener name+avatar + opened-at.
- Body Section: the customized first message OR opener subject+body (dominant).
- Buttons: Claim, Close, Open in web (link), Change category (opens ephemeral select from P5).'

mk $BOARD_BOT $REPO_BOT \
  'P5 — /tickets category <key> bot subcommand' \
  'Phase P5 (bot half) of the lantern plan.

Staff-only `/tickets category <key>` in `src/commands/tickets.ts`. Resolves new category by `(businessId, key)`, updates `tickets.category_id`, moves the Discord channel parent to the new category'"'"'s `discordParentCategoryId ?? business.discordFallbackCategoryId`, rebuilds per-channel permission overwrites for the new staff role set. Reuses the same DB write + channel-move path as the web action.'

mk $BOARD_WEB $REPO_WEB \
  'P5 — Change-category UI + server action on web ticket detail' \
  'Phase P5 (web half) of the lantern plan.

Admin-only action row in `/b/[slug]/tickets/[id]/page.tsx`: category `<select>` + Move button. New `changeTicketCategory(slug, ticketId, newCategoryId)` in `actions.ts`. Validates same-business membership, updates `tickets.category_id`, best-effort Discord channel move + overwrite rebuild (model after `archiveTicketChannel`). `revalidatePath`.'

mk $BOARD_WEB $REPO_WEB \
  'P6 — Add/remove ticket members on the web (People card)' \
  'Phase P6 of the lantern plan.

New admin/staff-only "People" card on `/b/[slug]/tickets/[id]`. Lists current per-user permission overwrites from `GET /channels/{id}` resolved via `fetchGuildMemberAsBot`.

Add: `<DiscordPicker kind="user" />` + Add button → `addTicketMember(slug, ticketId, discordUserId)` → PUT `/channels/{id}/permissions/{userId}` with the same bits the bot uses at `tickets.ts:289`. Upsert into `users` via `getOrCreateUserByDiscordId`.

Remove: × per row → `DELETE /channels/{id}/permissions/{userId}`. Refuse opener.

Bot side already done.'

# ---- M4 ---------------------------------------------------------------------
mk $BOARD_WEB $REPO_WEB \
  'P7 — Live refresh via SSE + Postgres LISTEN/NOTIFY (5s polling fallback)' \
  'Phase P7 of the lantern plan.

Postgres trigger (idempotent in `sql/triggers.sql`, applied by entrypoint after `drizzle-kit push`): AFTER INSERT on `ticket_messages` → `pg_notify('"'"'ticket_messages'"'"', payload)`. Similar trigger on ticket status/assignee/category changes (`tickets_meta` channel).

New `src/app/api/tickets/[id]/messages/stream/route.ts` — text/event-stream, `resolveTicketAccess` gate, dedicated `postgres` client running `LISTEN`, filters by ticket_id, 25s heartbeat.

REST companion `src/app/api/tickets/[id]/messages/route.ts` with `?since=<lastMessageId>` for catch-up + polling fallback.

New `'"'"'use client'"'"'` Conversation wrapper — EventSource on mount, append on event (no yank if user scrolled away), polling fallback at 5s when SSE drops.

Caddy + cloudflared already pass SSE; verify `flush_interval -1` stays on the `tickets.gg` block.'

mk $BOARD_WEB $REPO_WEB \
  'P8 — "All tickets I can see" cross-business tab' \
  'Phase P8 of the lantern plan.

New `/tickets` route. `accessibleBusinessIds` from `listMyBusinesses()` (React.cache'"'"'d). Single query: every row where `business_id IN accessibleBusinessIds` AND (admin/owner on that business OR opener OR (later) row exists in `ticket_external_members` from P16). Same row shape as the per-business queue + Business column. Reuses P9 sort/filter chrome.'

mk $BOARD_WEB $REPO_WEB \
  'P9 — Sort + filter on every ticket list' \
  'Phase P9 of the lantern plan.

URL state `?sort=<key>&dir=<asc|desc>` on `/b/[slug]/tickets` and `/tickets`. Sortable keys: `last`, `opened`, `id`, `subject`, `opener`, `status`, `category`. UI: clickable column headers with arrow + category multi-select chip pills. Status pills already exist at `tickets/page.tsx:71`.'

mk $BOARD_WEB $REPO_WEB \
  'P10 — Discord-formatted reply preview (two-pane reply form)' \
  'Phase P10 of the lantern plan.

Dep: `discord-markdown`.

Split `src/components/app/reply-form.tsx` into a two-pane layout: textarea left, live preview right. Resolve `<@id>`, `<#id>`, `<@&id>` mentions via P3 API routes + caches. Collapses to a tab on narrow screens. No bot change — Discord renders the raw text on receipt.'

# ---- M5 ---------------------------------------------------------------------
mk $BOARD_BOT $REPO_BOT \
  'P11 — Bot startup resync (orphan scan + panel reconcile + message backfill)' \
  'Phase P11 of the lantern plan.

New `src/bot/startupResync.ts` called once from `ready.ts` after gateway connect. Three idempotent passes:
1. Orphan-channel scan — open tickets with non-null `discord_channel_id`: 404 → null the id + flag new `tickets.needs_attention=true`.
2. Panel reconcile — verify every `ticket_panels.message_id` still exists, log if not.
3. Message backfill — for every open ticket with a channel, paginate `GET /channels/{id}/messages?after=<last_known_discord_message_id>` and insert missing rows (dedupe by `discord_message_id`, `source` chosen by which channel matches per v0.5.2 logic).

Errors → P12 `bot_errors`, never crash boot.'

mk $BOARD_BOT $REPO_BOT \
  'P12 — persistError helper + 5-day sweep in scheduledCleanup' \
  'Phase P12 (bot half) of the lantern plan.

`services/logger.ts` gets `persistError(err, context)` writing to `bot_errors`. Every `log.warn`/`log.error` that catches a thrown exception writes through.

`scheduledCleanup.ts` hourly loop adds a sibling sweep:
```sql
DELETE FROM bot_errors WHERE created_at < now() - interval '"'"'5 days'"'"'
```'

mk $BOARD_WEB $REPO_WEB \
  'P12 — bot_errors schema + sudo /admin/errors viewer' \
  'Phase P12 (web half) of the lantern plan.

New `src/db/schema/botErrors.ts`:
`id bigserial PK, level text, source text, message text, stack text, context jsonb, created_at timestamptz default now()`, index on `created_at`.

New `/admin/errors` page (sudo-only, embed in P15) renders the most recent 200 rows, filterable by level + source.'

# ---- M6 ---------------------------------------------------------------------
mk $BOARD_BOT $REPO_BOT \
  'P13 — /api/internal/dm endpoint on the bot (auth via INTERNAL_TOKEN)' \
  'Phase P13 (bot half) of the lantern plan.

Tiny HTTP endpoint inside the bot container at `/api/internal/dm` accepting `{ discordUserId, content }`, authed by a shared `INTERNAL_TOKEN` env var. Opens DM via REST and posts. Best-effort; failures into P12. Called by the web dispatcher (`src/server/notify.ts`).'

mk $BOARD_WEB $REPO_WEB \
  'P13 — Notification prefs (ntfy + DM) schema + UI + dispatcher' \
  'Phase P13 (web half) of the lantern plan.

New `user_notification_prefs` table (composite PK: user_id, business_id, category_id, channel, event). Null business/category = wildcard; most-specific wins.

`/settings/notifications` matrix UI — toggle grid + single ntfy_topic input per user.

New `src/server/notify.ts` — `notify(userId, event, payload)`. Fans out to ntfy POST and to the bot'"'"'s `/api/internal/dm`. Called from `replyToTicket`, `openTicket`, and via Postgres trigger from bot writes if cross-process needed.'

mk $BOARD_BOT $REPO_BOT \
  'P14 — Bot DM gateway → "open a bot-questions ticket" prompt' \
  'Phase P14 of the lantern plan.

`src/bot/events/messageCreate.ts` no longer early-returns on DMs. Replies with a Components V2 message: "I don'"'"'t handle DMs — open a ticket in the Bot Questions category" + 2 buttons:
- Open a bot-questions ticket → select for any business the user belongs to with a category flagged `is_bot_questions=true` (new boolean column). Fallback to the global owner-managed business (P15).
- Dismiss → delete the reply.'

mk $BOARD_WEB $REPO_WEB \
  'P15 — Sudo /admin/bot view (bot questions, errors, health)' \
  'Phase P15 of the lantern plan.

New `/admin/bot` (sudo-only). Three tabs:
- Bot questions — every ticket across every guild with category `is_bot_questions=true`.
- Errors — embed P12 `/admin/errors`.
- Health — last resync (P11), uptime, last gateway disconnect, leader status (P18), queued ntfy/DM dispatches.'

# ---- M7 ---------------------------------------------------------------------
mk $BOARD_WEB $REPO_WEB \
  'P16 — External Discord users by ID (no guild membership required)' \
  'Phase P16 of the lantern plan.

New `ticket_external_members` table (PK ticket_id, user_id; FKs to tickets + users + added_by user; added_at).

Extend `/b/[slug]/tickets/[id]` visibility check + P8 cross-business query to include `EXISTS (SELECT 1 FROM ticket_external_members …)`.

`addTicketMember` branches:
1. In the guild → existing channel-perm path (P6).
2. Not in the guild → upsert `users` from `GET /users/{id}` → insert `ticket_external_members` → best-effort DM with web link.

External user replies post via webhook spoof with `(external)` label. Removal deletes the row + best-effort DM.'

# ---- M8 ---------------------------------------------------------------------
mk $BOARD_BOT $REPO_BOT \
  'P17 — Bot stage in single combined Docker image' \
  'Phase P17 (bot half) of the lantern plan.

Existing bot Dockerfile build step lifts unchanged into Stage B of the new `Dockerfile.combined` (which lives in the web repo since web owns the schema). No bot-source change; this issue tracks the move and the verification.'

mk $BOARD_WEB $REPO_WEB \
  'P17 — Single combined Docker image (web + bot) with start.sh + dumb-init' \
  'Phase P17 (web half) of the lantern plan.

New `Dockerfile.combined` (3-stage), `start.sh` launching both Node processes with `[web]`/`[bot]` log prefixes and clean SIGTERM, `dumb-init` PID-1. Healthcheck probes web `/api/health` (P18) AND bot heartbeat file. New `docker-compose.combined.yml` recommended for fresh single-VPS installs. Existing split-image compose files stay.'

mk $BOARD_BOT $REPO_BOT \
  'P18 — Single-leader bot via Postgres advisory lock' \
  'Phase P18 (bot half) of the lantern plan.

New `src/bot/leader.ts`. On startup:
```ts
const got = await db.execute(sql`SELECT pg_try_advisory_lock(${BOT_LEADER_LOCK_ID})`)
if (!got.rows[0].pg_try_advisory_lock) { sleep 30s; retry; }
```
Lock auto-releases on session drop → failover within 30s. Log leader/follower at boot + on changes (P12).'

mk $BOARD_WEB $REPO_WEB \
  'P18 — /api/health route + Caddy multi-upstream LB block' \
  'Phase P18 (web half) of the lantern plan.

New `src/app/api/health/route.ts` returning 200 if Postgres reachable.

Caddy LB block in `euphoricfm-website/Caddyfile`:
```
reverse_proxy vps1:3000 vps2:3000 vps3:3000 {
  lb_policy least_conn
  health_uri /api/health
  health_interval 10s
}
```
No session affinity needed (web is stateless; LISTEN/NOTIFY is broadcast).'

mk $BOARD_WEB $REPO_WEB \
  'P19 — Tiered DB+settings backup via restic + GFS retention' \
  'Phase P19 of the lantern plan.

restic + `pg_dump --format=custom` piped via `--stdin`. Systemd timer: every 45min plus a daily anchor at 02:00. Retention via one `restic forget --prune` call:
```
--keep-within-hourly 5h --keep-daily 3 --keep-weekly 4 --keep-monthly 4
```
~17 retained snapshots ≈ 1.2–1.5× live DB size thanks to dedup.

Local primary repo at `/var/backups/restic-tickets`; nightly `rclone copy` mirror to Backblaze B2 (optional but cheap). Quarterly restore drill; failures → Uptime Kuma push (already wired).

Deliverables: `/usr/local/bin/tickets-backup.sh`, systemd `.service` + `.timer`, restore playbook under `docs/backup-restore.md`.'

# ---- Later (board placeholders) ---------------------------------------------
mk $BOARD_WEB $REPO_WEB \
  'L1 — LATER: Inbound email → ticket' \
  'Later phase L1 of the lantern plan — no code this batch.

Per-business address `tickets+<slug>@…`. MX → Postmark/SES inbound webhook → `ticket_messages.source='"'"'email'"'"'`. Replies email back to opener via same provider. Issue created now so the idea survives.'

mk $BOARD_WEB $REPO_WEB \
  'L2 — LATER: Webhook intake (Uptime Kuma, GitHub, generic)' \
  'Later phase L2 of the lantern plan — no code this batch.

Generic `POST /api/intake/<businessId>?token=…` opens a ticket in a designated category. Built-in shapes for Uptime Kuma + generic JSON Schema. Issue created now so the idea survives.'

echo
echo "== Done =="
# Read final counts from the tempfile (subshells wrote through it).
source "$COUNTERS"
rm -f "$COUNTERS" /tmp/.b
echo "Created: $CREATED  ·  Pre-existing reused: $EXISTING  ·  Added/refreshed on boards: $ADDED"
