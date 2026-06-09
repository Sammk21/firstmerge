# FirstMerge

**Good first issues that actually get merged.**

Every other tool lists issues with the `good first issue` label. FirstMerge goes
further: it scores each one on whether your pull request will actually *land* —
filtering out issues that are already claimed, stale, owned by maintainers who
never merge outside work, or already **closed**. Stop wasting weekends getting
ghosted.

100% free to build and run: GitHub's free API + a local SQLite cache. No ads, no
paywall, MIT licensed.

---

## Why it's different

The hard part of contributing isn't *finding* a labelled issue — it's knowing
whether it's worth your time. FirstMerge answers that with a **Merge Score**.

### The Merge Score (0–100, 🟢 / 🟡 / 🔴)

Each issue is scored on signals the competition ignores:

- **Availability** — unclaimed (no assignee, no linked PR) vs. already taken
- **Maintainer merge rate** — do they actually merge external PRs (last 90 days)?
- **Responsiveness** — typical time to first response
- **Repo liveness** — last commit recency
- **Beginner-fit** — short, well-scoped discussion vs. a 200-comment rabbit hole
- **Freshness** — recently opened vs. a stale zombie

Weights live in `lib/scoring.ts` and are fully tunable.

## Features

- 🎯 **Merge Score** badge + ring on every issue, with a hover breakdown of *why*
- ✅ **Unclaimed-only** filter — the one no competitor has
- ⭐ **Popularity sort & min-star filter** — most ↔ least popular repos
- 🔄 **Freshness guarantee** — a revalidation pass re-checks cached issues and
  hides anything that got closed or merged, with a "verified Xh ago" stamp
- 📊 **Dashboard** (`/dashboard`) — live GitHub API usage, score distribution,
  freshness, issues by language, top repos, and a **Fetch latest data** button
- ⚡ **Aggressive caching** — Redis when available, in-memory fallback otherwise
- 🆓 **Free to run** — ~$6/mo VPS; GitHub API + SQLite, zero paid services

## Stack

Next.js (App Router) monolith · SQLite via Node's built-in `node:sqlite` (zero
native deps) · GitHub REST through Octokit. One repo, one deploy.

```
app/              UI (server components) + /api/issues + /api/ingest + /dashboard
components/        FilterBar, IssueCard, SupportBanner, RefreshButton
lib/db.ts          data layer — swap to Postgres by rewriting just this file
lib/cache.ts       Redis (REDIS_URL) or in-memory cache
lib/issues.ts      cached read-through wrappers
lib/github.ts      GitHub fetch + signals + rate-limit handling + repo cache
lib/scoring.ts     the Merge Score (tune the weights here)
lib/ingest.ts      reusable ingest pipeline (CLI + button share it)
scripts/ingest.ts  CLI wrapper
```

## Quick start

```bash
cp .env.example .env       # add a free GITHUB_TOKEN (recommended)
npm install
npm run ingest             # pulls + scores issues into .data/firstmerge.db
npm run dev                # http://localhost:3000
```

A free **GitHub token** (classic PAT, no scopes needed for public data) lifts the
rate limit from 60/hr to 5,000/hr — strongly recommended. Create one at
https://github.com/settings/tokens and put it in `.env`.

## How data stays fresh

`npm run ingest` (or the dashboard button) pulls open good-first-issues, scores
them, and caches them. It then runs a bounded **revalidation pass** that re-checks
older issues against GitHub and hides any now closed/merged. Repo signals are
cached for 6h in the `repos` table, so repeated runs don't refetch the same repo —
even without Redis. Run it on a schedule (system cron or `node-cron`) to keep
things current.

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | Free PAT — lifts rate limit to 5k/hr (recommended) |
| `REDIS_URL` | Use Redis for caching; omit for in-memory (free) |
| `REVALIDATE_BUDGET` | Issues re-checked per ingest (default 150) |
| `REVALIDATE_AFTER_HOURS` | Re-check issues older than this (default 6) |
| `NEXT_PUBLIC_BMC_USERNAME` | Your Buy Me a Coffee handle |
| `NEXT_PUBLIC_REPO_URL` | Your repo URL for the UI links |

## Deploy

Self-host on a small VPS (Hetzner/DigitalOcean, ~$6/mo) behind Cloudflare's free
tier:

```bash
npm run build && npm start
```

Then schedule `npm run ingest` every few hours.

## License

MIT — see [LICENSE](./LICENSE). Free and open source. If it's useful, a
[coffee](https://buymeacoffee.com/) keeps the server on.
