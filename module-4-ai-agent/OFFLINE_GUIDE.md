# Module 4 · A durable AI agent (offline / local)

**Goal:** run an LLM underwriter as a **child workflow** whose every model call and
tool call is a durable, replayable activity — against a **local qwen model**, no
OpenAI key and no internet.

**Time:** ~35 min · **You'll edit:** `agent-workflow.ts` and `workflows.ts`.

The agent calls an OpenAI-compatible endpoint. Offline, you serve that endpoint
locally with [Ollama](https://ollama.com/) via docker compose; **the agent code is
unchanged** — it just points at a different base URL. This module's starter contains
the Module 3 solution.

You'll use **three terminals**, all from the repo root.

---

## Step 0 — Start the local model

One command starts Ollama, pulls the model, waits until it's ready, and writes the
env vars:

```bash
npm run local-llm        # or: ./scripts/local_llm.sh
source .env.offline      # OPENAI_BASE_URL / OPENAI_API_KEY / AGENT_MODEL
```

(Stop it later with `npm run local-llm:down`.)

<details>
<summary>Or do it by hand</summary>

```bash
docker compose up        # pulls qwen2.5:1.5b (~1GB, first time only)
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_API_KEY=ollama          # any non-empty value; Ollama ignores it
export AGENT_MODEL=qwen2.5:1.5b
```

</details>

> **Optional — mirror production with LiteLLM** (not required): `npm run local-llm -- --proxy`,
> then `source .env.offline`. Config: [../litellm/config.offline.yaml](../litellm/config.offline.yaml).

---

## Step 1 — Start the Temporal dev server

In **Terminal 1** (the env vars from Step 0 don't need to be here):

```bash
temporal server start-dev
```

✓ **Checkpoint:** **http://localhost:8233** loads.

---

## Step 2 — Write the agent tool-call loop

Open [starter/src/agent-workflow.ts](./starter/src/agent-workflow.ts).
`agent-activities.ts` (the LLM call + two mock tools) is already written. Fill in the
`// TODO` loop. For up to `MAX_TURNS`:

```ts
for (let turn = 1; turn <= MAX_TURNS; turn++) {
  const resp = await callAgentLLM({ messages });
  model = resp.model;
  // ...record the assistant's turn (its text + any toolCalls) onto messages...
  if (resp.toolCalls.length === 0) {
    const parsed = parseRecommendation(resp.text);   // model is done
    return { ...parsed, toolCallTrace, turns: turn, model, completedAt: new Date().toISOString() };
  }
  // ...otherwise dispatch each tool with dispatchTool(...), push a 'tool'
  //    message with the results, record them in toolCallTrace, and loop...
}
```

**Why:** each LLM call is non-deterministic, so it lives in an **activity**
(`callAgentLLM`). The **workflow** drives the loop, so every step is recorded in
history and the whole agent run is durable and replayable.

---

## Step 3 — Call the agent as a child workflow

Open [starter/src/workflows.ts](./starter/src/workflows.ts). After underwriting, run
the agent and store its recommendation. Wrap it in `try/catch` so an LLM outage
becomes an `ESCALATE` instead of a crash:

```ts
state.agentRecommendation = await executeChild(underwritingAgentWorkflow, {
  workflowId: `${app.applicationId}-agent`,
  args: [{ application: { ...app }, creditScore: 750 }],
});
```

Import `executeChild` from `@temporalio/workflow` and `underwritingAgentWorkflow`
from `./agent-workflow`.

**Why:** a child workflow gives the agent its own clean history and id, so its
tool-loop is independently inspectable and replayable.

---

## Step 4 — Run it and watch the agent reason

```bash
# Terminal 2 — worker (must have the env vars from Step 0 exported)
npx ts-node module-4-ai-agent/starter/src/worker.ts

# Terminal 3 — start a clean loan
npx ts-node module-4-ai-agent/starter/src/client.ts
```

✓ **Checkpoint:** in the UI, alongside `LOAN-001` you'll see a **second workflow**,
`LOAN-001-agent`, with one activity per model turn and one per tool call
(`lookupFullCreditReport`, `checkComplianceWatchlist`). The parent then parks at
`PENDING_APPROVAL`.

> **Heads up on the small model.** `qwen2.5:1.5b` runs on CPU and is slower and less
> reliable at tool-calling than a hosted model. If it can't produce a clean
> recommendation the workflow records `ESCALATE` — that's the designed fallback, not
> a bug. Bump to `qwen2.5:3b`/`7b` in [../docker-compose.yml](../docker-compose.yml)
> (and `AGENT_MODEL`) for steadier results.

---

## Step 5 — Approve to finish (fully offline)

The agent's recommendation is advisory — a human still decides:

```bash
temporal workflow signal --workflow-id LOAN-001 --name approveApplication
```

✓ **Checkpoint:** the workflow reaches **Completed**. (Run it in the browser course
site to also get a confetti celebration on completion.)

---

## Step 6 — Witness durability (kill the worker mid-think)

1. Start a clean loan and watch `LOAN-001-agent` make tool calls.
2. While it's mid-loop, **kill the worker** (Ctrl-C in Terminal 2). The completed
   turns are recorded in history.
3. **Restart the worker.**

✓ **Observe:** the agent resumes from the last recorded step — it does **not** re-run
the model/tool calls it already finished. Replay rebuilds the conversation from
history. That's an agent you can crash and resume safely.

---

## Concepts

- **Why an activity for the LLM call?** Model calls are non-deterministic; workflows
  must be deterministic, so anything non-deterministic *must* live in an activity
  whose result is recorded.
- **Why a child workflow?** Its own clean history and id, runnable on a dedicated
  worker, with an independently inspectable, replayable tool-loop.
- **The workflow drives the loop** — not the AI SDK (`maxSteps: 1`). That's what
  makes each step a durable checkpoint instead of one opaque black-box call.

---

## Questions to ponder

Take a moment to consolidate what you learned:

1. The model is non-deterministic, yet the workflow replays deterministically. How
   does putting `callAgentLLM` in an activity make that possible?
2. When you killed the worker mid-loop, the finished tool calls weren't repeated on
   resume. What did replay use to reconstruct the conversation so far?
3. Why run the agent as a *child* workflow instead of inlining the loop in the parent?
   What do you gain in the UI, in retries, and in worker placement?
4. The agent's recommendation is advisory and a human still approves. Why keep the
   human gate even when the model is confident?

---

## Stuck?

See [solution/src/agent-workflow.ts](./solution/src/agent-workflow.ts) and
[solution/src/workflows.ts](./solution/src/workflows.ts).

Done? Try the optional [saga / compensation stretch](../STRETCH-saga.md).
