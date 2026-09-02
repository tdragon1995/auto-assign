# Working from several devices

Home PC, work laptop and phone all talk to the same GitHub repo
(`tdragon1995/auto-assign`). Nothing else is shared between them — secrets and
tooling are per-machine, by design.

## What travels in git, what does not

| Travels | Stays on the machine |
|---|---|
| `dashboard/` source, `docs/`, `CLAUDE.md`, `.claude/commands`, `.claude/skills` | `dashboard/.env.local` (secrets, gitignored) |
| `.mcp.json`, `.claude/settings.json` | `.claude/settings.local.json`, `.vercel/`, `node_modules/` |

Config that ships in git must not name a machine. `.mcp.json` used to hard-code
`C:\Users\...\python.exe`, so the knowledge-graph server only started on the
laptop that wrote it; it now invokes `code-review-graph` off `PATH`, which is
what `.claude/settings.json`'s hooks already assumed. Keep it that way — if a
tool needs a path only one device has, put it in `.claude/settings.local.json`.

## Setting up a new laptop or PC

```bash
git clone https://github.com/tdragon1995/auto-assign
cd auto-assign/dashboard
npm install
cp .env.example .env.local     # then fill it in — see below
npm run dev                    # http://localhost:3000
```

Optional, for the knowledge-graph MCP server (`code-review-graph` in
`.mcp.json`): `pip install code-review-graph` and make sure the console script
is on `PATH`. Without it, the hooks and the MCP server both no-op — the repo
still works, you just fall back to Grep/Read.

### Filling in `.env.local`

Never commit or message these values. Two sources, both already holding them:

- **Vercel** — `npx vercel env pull dashboard/.env.local` from the repo root
  pulls production values straight into place (needs `npx vercel login` once).
- Otherwise copy from the Vercel dashboard → `diag-logistics` → Settings →
  Environment Variables.

`dashboard/.env.example` lists every key; `CLAUDE.md` explains what each is for.

## Moving work between devices

One branch per piece of work, pushed before you switch:

```bash
git switch -c my-change
# ... work ...
cd dashboard && npm run build   # pre-push checklist — Vercel runs the same build
cd .. && git add -A && git commit -m "..." && git push -u origin my-change
```

On the next device: `git fetch origin && git switch my-change`.

Do **not** leave uncommitted work behind and start the same edit elsewhere —
merging two half-finished copies of `assign.ts` by hand is how footguns get
reintroduced. If you must stop mid-thought, commit it as `wip:` and push.

Pushing to `master` deploys to production within ~2 minutes (see CLAUDE.md →
CI/CD), so `master` is only for finished work, from any device.

## Phone

A phone is for reviewing and steering, not for `npm run build`:

- **Claude Code on the web** (claude.ai/code) runs a session against this repo in
  a cloud container — it can read, edit, build and push on a branch while you
  read the diff on the phone. This is the practical way to do real work from a
  phone.
- **GitHub mobile** for reviewing PRs, reading CI, and merging.
- **The dashboard itself** (https://diag-logistics.vercel.app) is already the
  phone-side operational tool — assign cycles, "Cần xử lý", TAT. No checkout
  needed.

## Not worth doing

Syncing the working tree through Dropbox/OneDrive/iCloud. It corrupts `.git`
when two devices write at once, and it copies `node_modules/` and `.env.local`
into a third-party cloud. Git is the sync.
