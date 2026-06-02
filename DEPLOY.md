# Hosting & deploying the course site

This is for whoever **runs or deploys** the browser-based course site and its LLM
proxy. Workshop students don't need any of this — point them at the
[README](./README.md) for the learning content.

## How the browser path works

The course site (`course/`) is a Vue + Vite app served by a small Node process
([scripts/course-sandbox-runner.mjs](scripts/course-sandbox-runner.mjs)) that also
exposes the `/api` runner. When a student hits **Run**, the runner provisions an
on-demand [Daytona](https://www.daytona.io/) sandbox (a fresh Temporal dev server +
their worker), runs the client, and returns a signed Temporal UI link. All modules
use the same lightweight sandbox image (Node + the Temporal CLI).

For Module 4, the runner injects a shared [LiteLLM](https://docs.litellm.ai/) proxy
URL + key into the sandbox (`LLM_BASE_URL` / `LLM_API_KEY`), so the agent calls
OpenAI **without the real OpenAI key ever reaching student-editable code**. The
proxy is a separate Fly app — see [litellm/README.md](litellm/README.md) for its
setup and the security rationale.

## Develop the course site locally

```bash
npm install

# Terminal A — the Daytona-backed runner (needs a Daytona API key)
DAYTONA_KEY=your_daytona_key npm run course:sandbox

# Terminal B — the Vue dev server (proxies /api to the runner)
npm run course:serve
# open http://127.0.0.1:4173
```

Course data is generated from each `module-*/README.md` and the files under
`module-*/starter/src` (with `module-*/solution/src` behind the "solution" toggle).
Editing any of those regenerates the site automatically.

```bash
npm run course:build   # build the static bundle into course/dist
```

## Deploy to Fly.io

Two small [Fly.io](https://fly.io) apps:

**1. The course portal.** A single Node process serves the built site **and** the
`/api` runner from one origin (`COURSE_DIST_DIR` switches it on). The included
`Dockerfile`, `fly.toml`, and GitHub Actions workflow deploy it:

```bash
fly secrets set DAYTONA_KEY="$DAYTONA_KEY"
# So the runner can point Module 4 sandboxes at the LLM proxy (deployed below):
fly secrets set LLM_PROXY_URL=https://temporal-loan-llm-proxy.fly.dev \
                LLM_PROXY_KEY="$LLM_PROXY_KEY"
fly deploy
```

Pushes to `main` redeploy this automatically once the `FLY_API_TOKEN` repo secret
is set.

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

The proxy is deployed manually (re-run `fly deploy` from `litellm/` when its config
changes); it isn't wired into CI.
