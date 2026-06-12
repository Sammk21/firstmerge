# Contributing to FirstMerge

First time contributing to open source? **You're in the right place.** 🎉
FirstMerge is built to be a friendly first contribution: a real-world Next.js +
TypeScript codebase, beginner-sized issues, and a maintainer who actually reviews
PRs. This guide walks you through your first merge.

It's MIT licensed — use it, fork it, build on it, put it on your résumé. No
permission needed.

## Find something to work on

- Browse the [**good first issue**](https://github.com/Sammk21/firstmerge/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
  label — these are scoped specifically for newcomers.
- Comment on the issue to say you're taking it (so two people don't do the same
  work). No need to wait for a reply to start.
- Have a different idea? Open an issue first to check it's a good fit before
  spending your weekend on it.

## Set up the project locally

You'll need **Node.js 22+** (FirstMerge uses Node's built-in `node:sqlite`, so
there are no native build steps).

```bash
# 1. Fork the repo on GitHub (the "Fork" button, top-right)

# 2. Clone YOUR fork
git clone https://github.com/<your-username>/firstmerge.git
cd firstmerge

# 3. Install dependencies
npm install

# 4. Configure your environment
cp .env.example .env
#    Add a free GitHub token (classic PAT, no scopes needed for public data).
#    This lifts the API rate limit from 60/hr to 5,000/hr.
#    Create one at https://github.com/settings/tokens

# 5. Seed the local database with real issues
npm run ingest

# 6. Start the dev server
npm run dev          # http://localhost:3000
```

If you skip the GitHub token, ingest still works but you'll hit the 60 requests/hr
limit quickly.

## Make your change

```bash
# Create a branch off main
git checkout -b short-description-of-change

# ...make your edits...

# Check it works
npm run dev          # eyeball your change in the browser
npm run lint         # make sure linting passes
```

Keep pull requests **small and focused** — one issue per PR is much easier (and
faster) to review than a big mixed-bag change.

### A few conventions

- **TypeScript** everywhere — no `any` unless there's truly no alternative.
- Match the style of the file you're editing (naming, comments, formatting).
- This is a customized build of Next.js — when touching framework behavior, check
  the guides in `node_modules/next/dist/docs/` before writing code.
- The data layer lives entirely in `lib/db.ts`; the Merge Score logic lives in
  `lib/scoring.ts`. The `README.md` has a full file-by-file map of the repo.

## Open your pull request

```bash
git add .
git commit -m "Clear summary of what you changed"
git push origin short-description-of-change
```

Then on GitHub, open a Pull Request from your branch:

1. Go to your fork and click **"Compare & pull request."**
2. Give it a clear title and describe **what** you changed and **why**.
3. Link the issue it closes, e.g. `Closes #12`.
4. Submit! ✅

A maintainer will review it, maybe suggest a tweak or two, and merge. That's it —
you're officially an open-source contributor. 🚀

## Code of conduct

Be kind, be patient, assume good intent. This is a place to learn. Questions are
always welcome — open an issue or ask in the comments and we'll help you out.

Happy contributing! ❤️
