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
├── docker-compose.yml           <- local qwen model for offline Module 4
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

- **In your browser (zero local setup)** — the
  [live course site](https://temporal-training-agentic-loan-origination.fly.dev)
  lets you edit each module's code and run it live in an on-demand sandbox: a fresh
  Temporal dev server, your worker, and your loan application, with a one-click link
  into the Temporal Web UI. Module 4's agent calls OpenAI through a shared proxy —
  no per-student keys to manage. See [Run it in the browser](#run-it-in-the-browser)
  below.
- **Locally in four terminals** — the classic setup. See
  [How to run any module](#how-to-run-any-module). Module 4 calls OpenAI by
  default, or you can run it **fully offline** against a local qwen model — see
  [Run it offline](#run-it-offline-on-your-machine). Each module also has its own
  `OFFLINE_GUIDE.md`.

---

## Run it in the browser

Open the live course site at
**https://temporal-training-agentic-loan-origination.fly.dev** (or a link your
instructor shares). The left panel is an editor with each module's source files;
the right panel shows the module's instructions. Hit **Run** and a fresh sandbox is
provisioned that:

1. starts a Temporal dev server,
2. installs and starts your edited worker,
3. submits a loan application (Module 3 uses the failing `bad-ssn` scenario), and
4. hands back a signed **Temporal UI** link — open it to watch the event history
   and, from Module 2 on, **send approve / reject / retry signals** to drive your
   paused workflow.

For Module 4, the agent calls OpenAI through a shared proxy, so there are **no API
keys for you to manage** — and your edited code never sees a real key.

> **Hosting or developing the course site?** Running it locally and deploying it
> (Fly.io + the LLM proxy) are covered in [DEPLOY.md](./DEPLOY.md).

---

## Prerequisites (do this BEFORE the workshop)

1. **Node.js 18+** — `node --version`
2. **Temporal CLI** — https://docs.temporal.io/cli#install — `temporal --version`
3. **For Module 4's agent, pick one** (Modules 1–3 need neither):
   - **Online** — an OpenAI API key, exported before running the Module 4 worker:
     ```bash
     export OPENAI_API_KEY=sk-...      # leave LLM_BASE_URL unset to hit OpenAI directly
     ```
   - **Offline** — **Docker**, to run a local qwen model with no key and no
     internet. See [Run it offline](#run-it-offline-on-your-machine).

   (The browser path uses the shared proxy instead, so students need neither.)
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
#   e.g. temporal workflow query --workflow-id LOAN-SIGNALS-001 --type getState
```

> The worker does **not** hot-reload. After editing a workflow or activity, stop
> it (Ctrl-C) and start it again.

Open **http://localhost:8233** and click into your workflow to watch each step
appear in the event history. This native Temporal UI is the main thing you'll be
looking at all workshop.

---

## Run it offline (on your machine)

Everything above runs locally already. The only piece that reaches the internet
is **Module 4's agent**, which calls OpenAI by default. To run Module 4 with **no API key and no internet**, serve a small local model
with Docker. One command starts Ollama, pulls the model, and writes the env vars:

```bash
npm run local-llm        # wraps docker compose; writes .env.offline when ready
source .env.offline      # load LLM_BASE_URL / LLM_API_KEY / AGENT_MODEL
# ...then start the Module 4 worker as usual. Stop later with: npm run local-llm:down
```

That's equivalent to doing it by hand (the agent code is unchanged — it just points
at any OpenAI-compatible endpoint; only these env vars differ):

```bash
docker compose up        # starts Ollama and pulls qwen2.5:1.5b (~1GB, first time only)
export LLM_BASE_URL=http://localhost:11434/v1
export LLM_API_KEY=ollama          # any non-empty value; Ollama ignores it
export AGENT_MODEL=qwen2.5:1.5b
```

Modules 1–3 have no LLM, so they're already fully offline — no Docker needed.
Per-module steps are in each module's **`OFFLINE_GUIDE.md`** (start with
[module-4-ai-agent/OFFLINE_GUIDE.md](./module-4-ai-agent/OFFLINE_GUIDE.md)).

> The small qwen model is CPU-bound and less reliable at tool-calling than a
> hosted model; the agent's `ESCALATE` fallback covers the cases it can't parse.
> Bump to `qwen2.5:3b`/`7b` in [docker-compose.yml](./docker-compose.yml) (and
> `AGENT_MODEL`) for steadier results.
>
> **Optional:** `npm run local-llm -- --proxy` (or `docker compose --profile proxy
> up`) also starts a local LiteLLM proxy in front of Ollama, mirroring the
> production proxy shape (`agent-model` on `http://localhost:4000/v1`). Not required.

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
