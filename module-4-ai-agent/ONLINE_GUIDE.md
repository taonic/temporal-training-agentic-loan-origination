# Module 4 · A durable AI agent

**Goal:** run an LLM underwriter as a **child workflow** whose every model call and
tool call is a durable, replayable activity you can inspect in the UI.

**Time:** ~35 min · **You'll edit:** the `agent-workflow.ts` and `workflows.ts` tabs.

The agent calls OpenAI through a shared proxy — your sandbox gets a scoped key
automatically, so there's nothing to configure. If the model is ever unreachable,
the workflow records an `ESCALATE` recommendation instead of crashing. This module's
starter contains the Module 3 solution.

---

## Step 1 — Write the agent tool-call loop

Open the **`agent-workflow.ts`** tab. Everything except the loop is written for you:
`agent-activities.ts` has the LLM call (`callAgentLLM`) and two mock tools, and the
helpers `parseRecommendation` and `dispatchTool` are already in this file. Your job is
to fill in the loop where the `// TODO` is — delete the TODO comment block **and** the
placeholder `return` below it, then paste the chunks below in order.

The loop is one idea repeated: **call the model, see what it wants, act, repeat.**
Each chunk is one part of that. Paste them top to bottom and they form the whole loop.

### 1a — Open the loop and call the model

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

### 1b — Record the assistant's turn onto `messages`

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

### 1c — If the model asked for no tools, it's done

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

### 1d — Otherwise run each requested tool and feed results back

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
`toolCallId` ties each result to the call in 1b — and `toolCallTrace` keeps a clean
record for the UI. The closing `}` ends the `for` loop, so we go back to the top and
call the model again, now with the tool results in hand.

### 1e — After the loop: hit the turn cap → escalate

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
The **workflow** drives the loop — call the model, run the tools it asks for (each its
own activity), feed results back, repeat — so every step is recorded in history and the
whole agent run is durable and replayable.

---

## Step 2 — Call the agent as a child workflow

Open the **`workflows.ts`** tab. First, bring the two pieces you need into scope.

### 2a — Imports

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

### 2b — Run the agent after underwriting

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

**Why:** a child workflow gives the agent its own clean history and workflow id, so its
tool-loop is independently inspectable and replayable. The `try/catch` means an LLM
outage degrades to an `ESCALATE` recommendation rather than crashing the whole loan.

---

## Step 3 — Run it and watch the agent reason

Hit **Run** (the first run provisions the sandbox, so give it a moment).

✓ **Checkpoint:** open the **Temporal UI** button. Alongside `LOAN-AGENT-001` you'll see a
**second workflow**, `LOAN-AGENT-001-agent`, with one activity per model turn and one per
tool call (`lookupFullCreditReport`, `checkComplianceWatchlist`). That's the agent's
reasoning, made durable. The parent then parks at `PENDING_APPROVAL`.

---

## Step 4 — Approve to finish

The agent's recommendation is advisory — a human still decides. Send the approval
**signal** from the Temporal UI:

1. Click the **Temporal UI** button and open the running workflow **`LOAN-AGENT-001`**.
2. On the workflow page, open the actions menu in the **top-right** and choose
   **Send a Signal** (listed under *Workflow Actions*).
3. In the dialog, set **Signal name** to `approveApplication` and leave the
   **input** empty (this signal takes no arguments).
4. Click **Send a Signal** to submit.

✓ **Checkpoint:** the workflow advances to `APPROVED` and reaches **Completed** —
confetti. (To see the decline path instead, send `rejectApplication` — like
`approveApplication`, it takes no input.)

---

## Step 5 — Witness durability (kill the worker mid-think)

1. Hit **Run** and watch `LOAN-AGENT-001-agent` start making tool calls.
2. While it's mid-loop, click **■** next to **`worker.ts`** to kill the worker.
3. The agent child is **Running** but paused — its completed turns are recorded in
   history.
4. Click **▶** to restart the worker.

✓ **Observe:** the agent resumes from the last recorded step — it does **not**
re-run the model calls or tool calls it already finished. Replay rebuilds the
conversation from history. That's an agent you can crash and resume safely.

---

## Concepts

- **Why an activity for the LLM call?** Model calls are non-deterministic; workflows
  must be deterministic, so anything non-deterministic *must* live in an activity
  whose result is recorded.
- **Why a child workflow?** Its own clean history and id, runnable on a dedicated
  worker, with an independently inspectable and replayable tool-loop.
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

Use the **Switch to solution** toggle to compare `agent-workflow.ts` and
`workflows.ts` with working answers.

Done? Try the optional [saga / compensation stretch](../STRETCH-saga.md).
