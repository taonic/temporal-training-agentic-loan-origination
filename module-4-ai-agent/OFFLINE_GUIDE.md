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
source .env.offline      # LLM_BASE_URL / LLM_API_KEY / AGENT_MODEL
```

(Stop it later with `npm run local-llm:down`.)

<details>
<summary>Or do it by hand</summary>

```bash
docker compose up        # pulls qwen2.5:1.5b (~1GB, first time only)
export LLM_BASE_URL=http://localhost:11434/v1
export LLM_API_KEY=ollama          # any non-empty value; Ollama ignores it
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

Open [starter/src/agent-workflow.ts](./starter/src/agent-workflow.ts). Everything
except the loop is written for you: `agent-activities.ts` has the LLM call
(`callAgentLLM`) and two mock tools, and the helpers `parseRecommendation` and
`dispatchTool` are already in this file. Your job is to fill in the loop where the
`// TODO` is — delete the TODO comment block **and** the placeholder `return` below it,
then paste the chunks below in order.

The loop is one idea repeated: **call the model, see what it wants, act, repeat.**
Each chunk is one part of that. Paste them top to bottom and they form the whole loop.

### 2a — Open the loop and call the model

```ts
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    log.info(`Agent turn ${turn}/${MAX_TURNS}`);
    const resp = await callAgentLLM({ messages });
    model = resp.model;
```

`callAgentLLM` is an **activity**, so this one line is the non-deterministic model
call, recorded in history. `MAX_TURNS` caps the loop so a confused model can't spin
forever. `resp` holds the model's reply: `resp.text` (free text) and `resp.toolCalls`
(any tools it wants to run).

### 2b — Record the assistant's turn onto `messages`

```ts
    // Record the assistant's turn (its text + any tool calls it requested).
    const assistantParts: AgentMessageContent[] = [];
    if (resp.text) assistantParts.push({ type: 'text', text: resp.text });
    for (const tc of resp.toolCalls) {
      assistantParts.push({
        type: 'tool-call',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
      });
    }
    messages.push({ role: 'assistant', content: assistantParts });
```

This is the step that's easy to miss. The model is **stateless** — it only knows what's
in `messages`. So before we do anything else we append what it just said: its text plus
each tool call it requested. On the next turn we send the whole `messages` array back,
and *that's* how the model remembers it already asked for the credit report.

### 2c — If the model asked for no tools, it's done

```ts
    // No tool calls -> the model produced its final answer as plain text.
    if (resp.toolCalls.length === 0) {
      const parsed = parseRecommendation(resp.text);
      return {
        decision: parsed?.decision ?? 'ESCALATE',
        confidence: parsed?.confidence ?? 0,
        rationale: parsed?.rationale ?? `Could not parse recommendation: "${resp.text.slice(0, 200)}"`,
        toolCallTrace,
        turns: turn,
        model,
        completedAt: new Date().toISOString(),
      };
    }
```

No tool calls means the model stopped reasoning and gave a final answer.
`parseRecommendation` pulls `DECISION` / `CONFIDENCE` / `RATIONALE` out of its text. If
the text doesn't parse (`parsed` is `null`), we fall back to `ESCALATE` rather than
guess — a human reviews it.

### 2d — Otherwise run each requested tool and feed results back

```ts
    // Dispatch each requested tool as its own activity and feed results back.
    const toolResultParts: AgentMessageContent[] = [];
    for (const tc of resp.toolCalls) {
      const result = await dispatchTool(tc.toolName, tc.args);
      toolCallTrace.push({ tool: tc.toolName, args: tc.args, result });
      toolResultParts.push({
        type: 'tool-result',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        result,
      });
    }
    messages.push({ role: 'tool', content: toolResultParts });
  }
```

`dispatchTool` routes each call to its matching activity (another durable, recorded
step). We push the results back onto `messages` as a `tool` message — note the
`toolCallId` ties each result to the call in 2b — and `toolCallTrace` keeps a clean
record for the UI. The closing `}` ends the `for` loop, so we go back to the top and
call the model again, now with the tool results in hand.

### 2e — After the loop: hit the turn cap → escalate

```ts
  log.warn(`Agent hit MAX_TURNS (${MAX_TURNS}) without a final answer`);
  return {
    decision: 'ESCALATE',
    confidence: 0,
    rationale: `Agent reached ${MAX_TURNS} turns without submitting. A human should review.`,
    toolCallTrace,
    turns: MAX_TURNS,
    model,
    completedAt: new Date().toISOString(),
  };
```

If the loop runs all `MAX_TURNS` without the model settling on an answer, we stop and
escalate to a human rather than loop indefinitely.

**Why this shape:** each LLM call is non-deterministic, so it lives in an **activity**.
The **workflow** drives the loop, so every step is recorded in history and the whole
agent run is durable and replayable.

---

## Step 3 — Call the agent as a child workflow

Open [starter/src/workflows.ts](./starter/src/workflows.ts). First, bring the two
pieces you need into scope.

### 3a — Imports

Add `executeChild` to the existing `@temporalio/workflow` import:

```ts
import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  executeChild,
  log,
} from '@temporalio/workflow';
```

Then import the agent workflow itself (just below that import block):

```ts
import { underwritingAgentWorkflow } from './agent-workflow';
```

(The file already *re-exports* `underwritingAgentWorkflow` so the worker registers it;
this `import` is separate — it brings the function into scope so you can call it here.)

### 3b — Run the agent after underwriting

Find the `// TODO` block after the `underwrite` step and replace it with:

```ts
  // The AI underwriting agent runs as a CHILD workflow. It gets its own workflow
  // id ("<id>-agent") and its own history in the UI, so its tool-call loop is
  // independently inspectable. The recommendation comes back as a return value.
  setStatus('AGENT_REVIEWING');
  try {
    state.agentRecommendation = await executeChild(underwritingAgentWorkflow, {
      workflowId: `${app.applicationId}-agent`,
      args: [{ application: { ...app }, creditScore: 750 }],
    });
    log.info(`Agent recommended ${state.agentRecommendation.decision}`);
  } catch (err: any) {
    // Agent unavailable (e.g. the LLM is down) — record ESCALATE so the human
    // approver still sees something meaningful instead of a crash.
    log.warn(`Agent child failed: ${err.message || err}`);
    state.agentRecommendation = {
      decision: 'ESCALATE',
      confidence: 0,
      rationale: `Agent unavailable: ${err.message || String(err)}. Human review required.`,
      toolCallTrace: [],
      turns: 0,
      model: 'unavailable',
      completedAt: new Date().toISOString(),
    };
  }
  state.completedActivities.push('agentReview');
  setStatus('UNDERWRITTEN');
```

**Why:** a child workflow gives the agent its own clean history and id, so its
tool-loop is independently inspectable and replayable. The `try/catch` means an LLM
outage degrades to an `ESCALATE` recommendation rather than crashing the whole loan.

---

## Step 4 — Run it and watch the agent reason

```bash
# Terminal 2 — worker (must have the env vars from Step 0 exported)
npx ts-node module-4-ai-agent/starter/src/worker.ts

# Terminal 3 — start a clean loan
npx ts-node module-4-ai-agent/starter/src/client.ts
```

✓ **Checkpoint:** in the UI, alongside `LOAN-AGENT-001` you'll see a **second workflow**,
`LOAN-AGENT-001-agent`, with one activity per model turn and one per tool call
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
temporal workflow signal --workflow-id LOAN-AGENT-001 --name approveApplication
```

✓ **Checkpoint:** the workflow reaches **Completed**. (Run it in the browser course
site to also get a confetti celebration on completion.)

---

## Step 6 — Witness durability (kill the worker mid-think)

1. Start a clean loan and watch `LOAN-AGENT-001-agent` make tool calls.
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
2. Why run the agent as a *child* workflow instead of inlining the loop in the parent?
   What do you gain in the UI, in retries, and in worker placement?
3. The agent's recommendation is advisory and a human still approves. Why keep the
   human gate even when the model is confident?

---

## Stuck?

See [solution/src/agent-workflow.ts](./solution/src/agent-workflow.ts) and
[solution/src/workflows.ts](./solution/src/workflows.ts).

Done? Try the optional [saga / compensation stretch](../STRETCH-saga.md).
