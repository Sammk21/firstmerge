# FirstMerge — Project Context (read this first)

This is a single-file briefing so an AI assistant can be productive **without reading every source file**. It explains what the project is, how it's structured, the key flows, and the non-obvious decisions/gotchas that will trip you up if you don't know them.

---

## 1. What it is

**FirstMerge** finds GitHub "good first issues" that are actually worth a contributor's time. Every other tool just lists issues with the `good first issue` label. FirstMerge's wedge is the **Merge Score**: a 0–100 rating (bands: `green` / `yellow` / `red`) of how likely a PR on that issue is to actually get merged — filtering out issues that are already claimed, stale, from unresponsive maintainers, or already **closed**.

Free to run (GitHub's free API + a local DB), no ads, MIT licensed. A Buy Me a Coffee banner covers the ~$6/mo infra.

---

## 2. Stack & runtime model

- **Next.js (App Router), Next 16 + Turbopack, React 19.** ⚠️ This Next version has breaking changes vs. older training data — see `AGENTS.md`; when unsure, check `node_modules/next/dist/docs/`.
- **TypeScript** throughout, strict.
- **Tailwind v4** (via `@tailwindcss/postcss`). Styling is a mix of Tailwind utility classes + CSS variables (theme tokens) + some inline `style` for dynamic colors.
- **Data layer is a dual backend** chosen at runtime (see §4).
- **GitHub REST** via `@octokit/rest`.
- **Caching**: Redis (`ioredis`, optional) or in-memory fallback.
- Server Components by default; a few Client Components (`"use client"`).

---

## 3. Directory map (what each file does)

```
app/
  layout.tsx           Root layout. Inline <script> sets data-theme before paint (no FOUC).
  globals.css          Theme tokens (light/dark), base styles, .issue-card styles, View-Transition tuning.
  page.tsx             Home (server comp). Reads filters from searchParams, queries issues/langs/stats,
                       renders header + FilterBar + ResultsView + SupportBanner. Calls maybeRefreshInBackground via after().
  dashboard/page.tsx   Dashboard (server comp). Renders analytics(): totals, score distribution,
                       quality & momentum (avg score, opened-7d, %unclaimed, %green, star tiers), freshness, by-language, top repos.
  api/issues/route.ts  GET JSON issues API (mirrors page filters).
  api/ingest/route.ts  POST = dashboard "Fetch latest data" button (same-origin guarded).
                       GET  = cron entrypoint (Bearer CRON_SECRET/INGEST_SECRET). Both call runIngest().

components/
  FilterBar.tsx        Client. Band pills, Language/Sort/Min-stars dropdowns, "Unclaimed only" toggle. Writes URL params.
  ResultsView.tsx      Client. List/grid segmented control + "Group by repo" toggle. Grouping is client-side
                       over already-fetched issues. Prefs (view/group) persisted in localStorage via useSyncExternalStore.
  IssueCard.tsx        Server. Score ring (SVG), star count, meta row, hover-reveal "why this score" signal chips.
  ThemeToggle.tsx      Client. Light/dark via data-theme + localStorage. Uses View Transitions API for the crossfade.
  SupportBanner.tsx    Buy Me a Coffee + open-source links. Handles come from lib/config.ts.

lib/
  db.ts                FACADE. Re-exports types + async functions. Picks backend: DATABASE_URL set -> Postgres, else SQLite.
                       Lazy dynamic import so only the chosen backend module loads.
  db-types.ts          Shared types + ORDER_BY whitelist + Analytics shape. Pure types/constants — safe anywhere.
  db-sqlite.ts         SQLite backend (node:sqlite). LOCAL DEV. Node runtime only.
  db-postgres.ts       Neon (@neondatabase/serverless HTTP) backend. PRODUCTION on Vercel. Edge/serverless safe.
  scoring.ts           computeMergeScore(signals) -> { score, band, reasons }. Pure. Tune weights here.
  github.ts            Octokit calls: searchGoodFirstIssues, fetchRepoSignals (+DB cache), getIssueState, getRateUsage,
                       rateLimitRemaining. Central callGh() wrapper handles rate limits/backoff.
  ingest.ts            runIngest() pipeline (CLI + button share it). Also maybeRefreshInBackground() for on-demand refresh.
  issues.ts            Cached read-through wrappers (getIssues/getLanguages/getStats) + invalidateReadCaches().
  cache.ts             Redis-or-memory cache: cacheGet/cacheSet/getOrSet/invalidatePrefix + TTL presets.
  config.ts            BMC handle + repo URL (env-overridable).

scripts/
  ingest.ts            Thin CLI wrapper -> runIngest(). Run via `npm run ingest`.
```

---

## 4. Data layer (important)

**One facade, two backends, identical async surface.** All app code imports ONLY from `lib/db.ts`. Every function is `async` (returns a Promise) so the two backends share one signature.

- `DATABASE_URL` set → **Postgres** (`db-postgres.ts`, Neon HTTP driver — works in serverless/edge).
- otherwise → **SQLite** (`db-sqlite.ts`, Node's built-in `node:sqlite`, zero native deps; local dev).

**If you change a query or add an analytics field, you MUST update BOTH `db-sqlite.ts` and `db-postgres.ts`, plus the shared types in `db-types.ts`.** They are kept in sync by hand.

**Tables** (`repos`, `issues`): see the `CREATE TABLE` in either backend. Key issue columns: `merge_score`, `score_band`, `state` (`open`/`closed`), `is_assigned`, `has_linked_pr`, `last_checked_at`, `last_seen_at`, `fetched_at`. `is_assigned`/`has_linked_pr` are kept as 0/1 numbers in `IssueRow` (Postgres BOOLEAN is normalized back to 0/1) so components/scoring don't change.

**Reads only return `state='open'`** — closed issues are never shown (the old `includeClosed`/"Show closed" toggle was removed as bloat).

**Untrusted query params** (homepage searchParams and `/api/issues`) are parsed by **`parseIssueQuery` in `db-types.ts`** — the single place that validates `band`/`sort` against whitelists, sanitizes numbers, and clamps `limit` (max 100). Never hand-parse params in a page/route.

---

## 5. Key flows

### Ingest (`lib/ingest.ts → runIngest`)
For each language: `searchGoodFirstIssues` → for each issue, upsert repo (deduped) + compute Merge Score + upsert issue. Then **revalidate** older issues. Then invalidate read caches. Bounded & rate-limit-aware. Shared by the CLI and the dashboard button.

### Freshness / revalidation (the core trust feature)
An issue open at ingest time can get closed/merged later. `revalidate()` pulls the oldest-verified open issues (`staleOpenIssues`), re-checks each via `getIssueState` (a cheap GitHub call), and marks closed ones — which hides them from results. Cards show "verified Xh ago". Budget: `REVALIDATE_BUDGET` issues older than `REVALIDATE_AFTER_HOURS`.

### On-demand background refresh (`maybeRefreshInBackground`)
Called from `page.tsx` via `after()` (runs AFTER the response is sent — never blocks). A cache-stored cooldown stamp (`ONDEMAND_COOLDOWN_MIN`) prevents a stampede. Keeps data fresh on Vercel Hobby where cron is limited.

### Caching (`lib/cache.ts` + `lib/issues.ts`)
Read paths go through `getOrSet`. Issue lists/languages/stats are cached (short TTL); repo signals cached 6h. `REDIS_URL` set → Redis, else in-memory. Cache never throws into the request path.

### Repo signal cache (cross-run dedupe)
`github.ts fetchRepoSignals` first checks the DB `repos` table (`getRepoIfFresh`, 6h window) before hitting GitHub — so repeated ingests don't refetch the same repo, even without Redis.

### Scoring (`lib/scoring.ts`)
Pure function over signals: availability (unclaimed), maintainer merge rate, responsiveness, repo liveness, comment-thread size, freshness. Returns score + band + human reasons. Weights are explicit and tunable.

### Theme (`ThemeToggle.tsx` + `globals.css`)
`data-theme` attribute on `<html>` + localStorage; layout sets it pre-paint. Toggle uses the **View Transitions API** for one GPU-composited crossfade. ⚠️ Do NOT add a CSS `transition` to `[data-theme] *` / all elements — that caused severe toggle lag and was removed.

### Grouping (`ResultsView.tsx`)
"Group by repo" is **purely client-side** over the already-fetched issues (group by `repo_full`, collapsible `<details>` sections). No DB change.

---

## 6. API routes

- `GET /api/issues` — JSON issues; query params mirror the homepage filters (`language`, `band`, `unclaimed`, `minStars`, `sort`, `limit`).
- `GET /api/feed` — Atom feed of issues, same filter params; linked from the homepage footer with the active filters. Subscribe to e.g. `?band=green&unclaimed=1&language=Rust`.
- `POST /api/ingest` — runs an ingest; same-origin (dashboard button) or Bearer secret.
- `GET /api/ingest` — cron entrypoint; requires `Authorization: Bearer <CRON_SECRET|INGEST_SECRET>` in prod.

---

## 7. Environment variables

| Var | Effect |
|---|---|
| `GITHUB_TOKEN` | Free PAT; lifts rate limit 60/hr → 5,000/hr. **Strongly recommended.** |
| `DATABASE_URL` | If set → Postgres (Neon) backend; else SQLite local. |
| `REDIS_URL` | If set → Redis cache; else in-memory. |
| `CRON_SECRET` / `INGEST_SECRET` | Bearer secret authorizing unattended ingest (GET /api/ingest). |
| `REVALIDATE_BUDGET` (150) / `REVALIDATE_AFTER_HOURS` (6) | Revalidation pass bounds. |
| `ONDEMAND_COOLDOWN_MIN` (60) / `ONDEMAND_LANGUAGES` | On-demand background refresh tuning. |
| `INGEST_LANGUAGES` / `INGEST_PAGES` (1) / `INGEST_PER_PAGE` (40) | Ingest scope. |
| `NEXT_PUBLIC_BMC_USERNAME` / `NEXT_PUBLIC_REPO_URL` | UI links (Buy Me a Coffee, repo). |

---

## 8. Gotchas & conventions (the stuff that will bite you)

1. **node:sqlite is loaded via `process.getBuiltinModule("node:sqlite")`**, NOT `import`/`require`. Turbopack tried to externalize the builtin and threw "require is not defined". Don't change this.
2. **node:sqlite rows have a null prototype** → Next's RSC serializer rejects them across the client boundary. Backends spread rows into plain objects (`{ ...r }`) before returning. Keep doing this.
3. **Two backends must stay in sync.** Any query/analytics change → edit `db-sqlite.ts` AND `db-postgres.ts` AND `db-types.ts`. SQLite uses `@named` params; Postgres uses `$1` positional + a `p()` helper.
4. **GitHub `label:` is ANDed.** Multiple `label:` qualifiers require ALL labels at once (returns ~nothing). Use a single `label:"good first issue"`. (This was a real bug.)
5. **Rate limits**: `callGh()` waits out the Search primary limit but **bails** (`bailOnPrimaryLimit`) on the Core bucket for repo/issue calls so an unauthenticated run can't hang an hour; repo enrichment degrades to a minimal repo instead of failing the run.
6. **Don't add universal CSS transitions** (theme lag — see §5 Theme).
7. **Client prefs** (theme, view, group) use `useSyncExternalStore` reading localStorage with a stable server snapshot — avoids hydration mismatches. Follow that pattern for new prefs.
8. **`after()` for background work** — never block the response with an ingest.
9. The data layer is **async everywhere** even though SQLite is synchronous under the hood (to match Postgres). Always `await` db calls.

---

## 9. Run / deploy

```bash
cp .env.example .env      # add GITHUB_TOKEN
npm install
npm run ingest            # seed the DB
npm run dev               # http://localhost:3000  (dashboard at /dashboard)
```

Production: set `DATABASE_URL` (Neon) + `GITHUB_TOKEN` (+ optionally `REDIS_URL`, `CRON_SECRET`), deploy to Vercel, schedule `GET /api/ingest` via cron.

Verification without a full dev server: `npx tsc --noEmit` typechecks everything (pure JS, fast). Pure modules (`scoring.ts`, the SQLite backend) can be compiled with `tsc` and exercised under plain `node` for quick runtime checks.

---

## 10. Current state

Core product is built and working: scoring, dual-backend persistence, freshness/revalidation, caching, rate-limit handling, homepage with filters/sort/grouping/list-grid, dashboard analytics, ingest CLI + button + cron, theme toggle, support banner. Repo is initialized; pushes happen from the owner's machine (SSH to `github.com:Sammk21/firstmerge`).

Reasonable next steps if asked: GitHub Actions scheduled ingest, per-repo average score in group headers, persisted collapse state, more historical/trend analytics (needs storing snapshots over time), tests.
