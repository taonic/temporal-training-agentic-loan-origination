# Shared LLM proxy for the workshop

Lets ~30 students run Module 4's AI agent against **OpenAI** without ever putting
the real OpenAI key where they can read it. **No database required.**

## Why a proxy at all

Students edit and run code inside their Daytona sandbox, so **any key in the
sandbox is readable by the student** — `console.log(process.env.LLM_API_KEY)`
is enough. There is no "secure" way to bake a real key into a place where the
student runs arbitrary code.

So the real OpenAI key lives only here, in the proxy. Sandboxes get the proxy's
**shared key** instead (as `LLM_API_KEY` — a provider-neutral name, since the
endpoint the agent talks to is the proxy, not OpenAI):

```
sandbox (student-editable)   ──shared key──▶   LiteLLM proxy   ──real OpenAI key──▶   OpenAI
   LLM_BASE_URL ───────────────────────────▶  (Fly secret)
```

The shared key only reaches OpenAI *through* the proxy, which applies a global
rate limit, and the OpenAI project carries a **hard spend cap** — so a leaked
shared key can't drain your account or run wild.

> **Tradeoff (no DB).** Per-student budgets and per-key rpm/tpm are a LiteLLM
> *database* feature. Without Postgres we use one shared key + global limits, so
> isolation is at the class level, not per student. The OpenAI spend cap is the
> real budget backstop. If you later want per-student isolation back, add a
> Postgres DB and LiteLLM's `/key/generate` (or a small custom proxy).

## What's here

| File | Purpose |
|------|---------|
| `config.yaml` | Maps the agent's `agent-model` to a real OpenAI model; global rate limits; shared key. |
| `Dockerfile` | Bakes `config.yaml` into the published LiteLLM image. |
| `fly.toml` | Deploys the proxy as its own small Fly app. |

## Deploy the proxy (one-time)

From this directory:

```bash
fly launch --no-deploy --copy-config --name temporal-loan-llm-proxy

# Load the real key from your environment instead of pasting it (keeps it out of
# shell history): export OPENAI_API_KEY=sk-...real... first.
fly secrets set OPENAI_API_KEY="$OPENAI_API_KEY"

# Generate one strong shared key and reuse it for both apps (it's also the
# LLM_PROXY_KEY the portal needs below). LiteLLM expects the sk- prefix.
export LLM_PROXY_KEY="sk-$(openssl rand -hex 32)"
fly secrets set LITELLM_MASTER_KEY="$LLM_PROXY_KEY"

fly deploy
```

## Point the course runner at the proxy

The portal app (the one running `course-sandbox-runner.mjs`) needs two secrets:

```bash
# Reuses the $LLM_PROXY_KEY you generated above, so the two apps share the key by
# construction. (In a fresh shell, set it to the same value first.)
fly secrets set LLM_PROXY_URL=https://temporal-loan-llm-proxy.fly.dev \
                LLM_PROXY_KEY="$LLM_PROXY_KEY" \
                -a temporal-agentic-loan-origination
```

The runner then injects `LLM_BASE_URL`, `LLM_API_KEY` (the shared key), and
`AGENT_MODEL=agent-model` into each Module 4 sandbox. The agent picks them up
automatically — see
[agent-activities.ts](../module-4-ai-agent/solution/src/agent-activities.ts).

## Rate-limit sizing (the 30-concurrent question)

The agent runs a **tool loop**: one "run" ≈ 2–4 LLM calls, each re-sending the
growing transcript, and the class tends to click run *at the same moment*. So
size for the **burst**, and remember **TPM usually bites before RPM**.

- `config.yaml` sets a global ceiling: `max_parallel_requests`, plus deployment
  `rpm`/`tpm` on the model. Keep these just under your OpenAI **org/project tier**
  for the chosen model (Tier 1 is low — consider upgrading before the workshop).
- Temporal also caps LLM-call retries (`maximumAttempts: 5` in
  [agent-workflow.ts](../module-4-ai-agent/solution/src/agent-workflow.ts)), so a
  throttled run **ESCALATEs** instead of hammering the shared bucket forever.

## After the workshop

Rotate the shared key and idle the proxy to stop paying:

```bash
fly secrets set LITELLM_MASTER_KEY=sk-...new... -a temporal-loan-llm-proxy
fly scale count 0 -a temporal-loan-llm-proxy   # scale back up next time
```
