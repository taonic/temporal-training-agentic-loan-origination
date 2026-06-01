# Workshop: Durable AI Agents with Temporal

A 3-hour, hands-on workshop. You will build a loan-origination workflow from
scratch, one concept at a time, and finish with a **durable AI underwriting
agent** running as a child workflow.

No prior Temporal or agentic-AI experience required.

---

## What you'll build

```
Verify Income → Credit Check → Underwriting → AI Agent Review → Human Approval
```

Each module lives in its own self-contained folder with a `starter/` (what you
edit) and a `solution/` (the answer), plus its own README:

| Module | Folder | New Temporal concept |
|--------|--------|----------------------|
| 1 · Durable pipeline | [module-1-durable-pipeline](./module-1-durable-pipeline/) | activities, retries, **durability** |
| 2 · Signals & Queries | [module-2-signals-queries](./module-2-signals-queries/) | signals, queries, `condition` |
| 3 · Recoverable pattern | [module-3-recoverable](./module-3-recoverable/) | `ApplicationFailure`, signal-driven recovery |
| 4 · Durable AI agent | [module-4-ai-agent](./module-4-ai-agent/) | child workflows, agentic tool-loop |

Each module's `starter/` already contains the **previous** module's completed
solution, so you can do the modules independently or in order. There is also an
optional [saga / compensation stretch](./STRETCH-saga.md). A fuller reference
implementation of every pattern (plus saga, cancellation, and a dashboard) lives
in the companion `temporal-loan-origination-demo` repo.

```
temporal-training-agentic-loan-origination/
├── package.json, tsconfig.json
├── litellm/                     <- the shared OpenAI proxy (Module 4)
├── module-1-durable-pipeline/
│   ├── README.md
│   ├── starter/src/      <- you edit this (has TODOs)
│   └── solution/src/     <- the answer
├── module-2-signals-queries/   (same shape)
├── module-3-recoverable/       (same shape)
└── module-4-ai-agent/          (same shape)
```

---

## Two ways to run this workshop

- **In your browser (zero local setup)** — a Vue course site lets you edit each
  module's code and run it live in an on-demand [Daytona](https://www.daytona.io/)
  sandbox: a fresh Temporal dev server, your worker, and your loan application,
  with a one-click link into the Temporal Web UI. Module 4's agent calls OpenAI
  through a shared proxy — no per-student keys to manage. See
  [Run it in the browser](#run-it-in-the-browser) below.
- **Locally in four terminals** — the classic setup. See
  [How to run any module](#how-to-run-any-module).

---

## Run it in the browser

The course site (`course/`) is a Vue + Vite app. The left panel is an editor with
each module's source files; the right panel shows the module's instructions. Hit
**Run** and a Daytona sandbox is provisioned that:

1. starts a Temporal dev server,
2. installs and starts your edited worker,
3. submits a loan application (Module 3 uses the failing `bad-ssn` scenario), and
4. hands back a signed **Temporal UI** link — open it to watch the event history
   and, from Module 2 on, **send approve / reject / retry signals** to drive your
   paused workflow.

For Module 4 the runner points the sandbox at a shared
[LiteLLM](https://docs.litellm.ai/) proxy (injecting its URL + shared key), so the
agent calls OpenAI without the real OpenAI key ever reaching student-editable code.
All modules use the same lightweight sandbox image (Node + the Temporal CLI). See
[litellm/README.md](litellm/README.md) for the proxy setup.

### Develop the course site locally

```bash
npm install

# Terminal A — the Daytona-backed runner (needs a Daytona API key)
DAYTONA_KEY=your_daytona_key npm run course:sandbox

# Terminal B — the Vue dev server (proxies /api to the runner)
npm run course:serve
# open http://127.0.0.1:4173
```

Course data is generated from each `module-*/README.md` and the files under
`module-*/starter/src` (with `module-*/solution/src` behind the "solution"
toggle). Editing any of those regenerates the site automatically.

```bash
npm run course:build   # build the static bundle into course/dist
```

### Deploy

Two small [Fly.io](https://fly.io) apps:

**1. The course portal.** A single Node process serves the built site **and** the
`/api` runner from one origin (`COURSE_DIST_DIR` switches it on). The included
`Dockerfile`, `fly.toml`, and GitHub Actions workflow deploy it:

```bash
fly secrets set DAYTONA_KEY=your_daytona_key
# So the runner can point Module 4 sandboxes at the LLM proxy (deployed below):
fly secrets set LLM_PROXY_URL=https://temporal-loan-llm-proxy.fly.dev \
                LLM_PROXY_KEY=sk-...shared-key...
fly deploy
```

Pushes to `main` redeploy automatically once the `FLY_API_TOKEN` repo secret is set.

**2. The LLM proxy.** Holds the **real OpenAI key** so it never reaches a sandbox,
and exposes a single shared key (the same value as `LLM_PROXY_KEY` above) behind a
global rate limit. No database. Deploy from [`litellm/`](litellm/) (full steps in
[litellm/README.md](litellm/README.md)):

```bash
cd litellm
fly secrets set OPENAI_API_KEY=sk-...real... LITELLM_MASTER_KEY=sk-...shared-key...
fly deploy
# then set a hard spend cap on that OpenAI project — your budget backstop
```

---

## Prerequisites (do this BEFORE the workshop)

1. **Node.js 18+** — `node --version`
2. **Temporal CLI** — https://docs.temporal.io/cli#install — `temporal --version`
3. **An OpenAI API key** (for Module 4's agent) — export it before running the
   Module 4 worker:
   ```bash
   export OPENAI_API_KEY=sk-...        # leave OPENAI_BASE_URL unset to hit OpenAI directly
   ```
   Modules 1–3 need no key. (The browser path uses the shared proxy instead, so
   students don't need their own key.)
4. **Install deps** (from the repo root): `npm install`
5. **Smoke-test the dev server:**
   ```bash
   temporal server start-dev
   # open http://localhost:8233 (the Temporal Web UI), then Ctrl-C
   ```

---

## How to run any module

You'll use **four terminals**, all from the repo root. Swap the module folder and
`starter`/`solution` as needed.

```bash
# Terminal 1 — Temporal dev server (Web UI on http://localhost:8233)
temporal server start-dev

# Terminal 2 — the worker (re-run after every code change)
npx ts-node <module-folder>/starter/src/worker.ts

# Terminal 3 — start a loan application
npx ts-node <module-folder>/starter/src/client.ts
#   add `bad-ssn` to start a failing application (used in Module 3)

# Terminal 4 — send signals / run queries (Module 2 onward)
#   e.g. temporal workflow query --workflow-id LOAN-001 --type getState
```

> The worker does **not** hot-reload. After editing a workflow or activity, stop
> it (Ctrl-C) and start it again.

Open **http://localhost:8233** and click into your workflow to watch each step
appear in the event history. This native Temporal UI is the main thing you'll be
looking at all workshop.

---

## Start here

→ **[Module 1 · A durable pipeline](./module-1-durable-pipeline/README.md)**

Then work through Modules 2, 3, and 4 in order. Each module's README has its own
run commands, tasks, and concept notes.

## Wrap-up

You'll have built a durable, recoverable, human-in-the-loop loan pipeline with an
AI agent — and none of it breaks when a process dies.

Where to go next:
- **Stretch:** [STRETCH-saga.md](./STRETCH-saga.md) — undo side effects with the
  saga / compensation pattern.
- **Reference:** the companion `temporal-loan-origination-demo` repo has the full
  version (saga, cancellation propagation, search attributes, and a dashboard).
- **Docs:** https://docs.temporal.io
