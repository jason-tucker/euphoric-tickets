# Test Results — security review pass (v0.7.1)

Commit base `d7c4c51` · branch `claude/pensive-dirac-4e5f7g` · 2026-06-09.

There is **no test framework** in this repo (no `vitest`/`jest`, no `test`
script). Verification therefore relied on the TypeScript compiler, the dependency
auditor, and a structured code review of the diff. This is recorded honestly — no
test suite was run because none exists (tracked as **F9**).

| Command | Result | Notes |
|---|---|---|
| `pnpm install --frozen-lockfile` | ✅ pass (exit 0) | pnpm 10 ignored build scripts (esbuild) — expected/safe |
| `node node_modules/typescript/bin/tsc --noEmit` (baseline, pre-fix) | ✅ pass (exit 0) | clean baseline |
| `node node_modules/typescript/bin/tsc --noEmit` (post-fix) | ✅ pass (exit 0) | fixes compile cleanly |
| `pnpm audit` | ⚠️ 1 moderate | `esbuild` via `drizzle-kit` (devDep); not runtime-reachable — see `DEPENDENCY_AND_SBOM_NOTES.md` |
| `pnpm audit --prod` equivalent | ✅ no prod advisories | the single finding is dev-only |
| code-review skill on the diff | ✅ no correctness findings | traced line-by-line, removed-behavior, cross-file callers, language pitfalls |

## End-to-end verification

**Not run.** The bot requires a live `DISCORD_BOT_TOKEN`, a real guild, and the
shared Postgres (`tickets-db`) to exercise its flows; none are available in the
review sandbox, and the network policy does not provide them. Recommended manual
e2e after deploy is in `DEPLOYMENT_AND_ROLLBACK.md` (open a ticket → `/tickets
close` → verify the confirm is ephemeral and only the opener/staff can complete
it; verify a `/tickets add`-ed non-staff member is denied at the confirm step).

## Recommended tests to add (F9)
- `tokenMatches(presented, secret)`: equal → true; differing same-length → false;
  length mismatch → false; `string[]` / `undefined` header → false.
- `escapeHtml`: `<script>`, quotes, ampersands.
- `validatePanelCategoriesJson`: non-array, >5, bad key regex, missing label.
- rename slugify: unicode/symbols collapse to `ticket-<id>-<slug>`.
- authz matrix on `resolveTicketAccess`: opener vs staff vs admin vs outsider,
  and a two-business fixture for cross-tenant denial (pairs with F3).
