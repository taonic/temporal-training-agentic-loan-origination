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

Open the **`agent-workflow.ts`** tab. `agent-activities.ts` (the LLM call + two mock
tools) is already written. Fill in the `// TODO` loop. For up to `MAX_TURNS`:

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
(`callAgentLLM`). The **workflow** drives the loop — call the model, run the tools it
asks for (each its own activity), feed results back, repeat — so every step is
recorded in history and the whole agent run is durable and replayable.

---

## Step 2 — Call the agent as a child workflow

Open the **`workflows.ts`** tab. After underwriting, run the agent and store its
recommendation. Wrap it in `try/catch` so an LLM outage becomes an `ESCALATE`
instead of a crash:

```ts
state.agentRecommendation = await executeChild(underwritingAgentWorkflow, {
  workflowId: `${app.applicationId}-agent`,
  args: [{ application: { ...app }, creditScore: 750 }],
});
```

Import `executeChild` from `@temporalio/workflow` and `underwritingAgentWorkflow`
from `./agent-workflow`.

**Why:** a child workflow gives the agent its own clean history and workflow id, so
its tool-loop is independently inspectable and replayable.

---

## Step 3 — Run it and watch the agent reason

Hit **Run** (the first run provisions the sandbox, so give it a moment).

✓ **Checkpoint:** open the **Temporal UI** button. Alongside `LOAN-001` you'll see a
**second workflow**, `LOAN-001-agent`, with one activity per model turn and one per
tool call (`lookupFullCreditReport`, `checkComplianceWatchlist`). That's the agent's
reasoning, made durable. The parent then parks at `PENDING_APPROVAL`.

---

## Step 4 — Approve to finish

The agent's recommendation is advisory — a human still decides. Send the approval
**signal** from the Temporal UI:

1. Click the **Temporal UI** button and open the running workflow **`LOAN-001`**.
2. On the workflow page, open the actions menu in the **top-right** and choose
   **Send a Signal** (listed under *Workflow Actions*).
3. In the dialog, set **Signal name** to `approveApplication` and leave the
   **input** empty (this signal takes no arguments).
4. Click **Send a Signal** to submit.

✓ **Checkpoint:** the workflow advances to `APPROVED` and reaches **Completed** —
confetti. (To see the decline path instead, send `rejectApplication` with input
`{ "reason": "Policy exception" }`.)

---

## Step 5 — Witness durability (kill the worker mid-think)

1. Hit **Run** and watch `LOAN-001-agent` start making tool calls.
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
2. When you killed the worker mid-loop, the finished tool calls weren't repeated on
   resume. What did replay use to reconstruct the conversation so far?
3. Why run the agent as a *child* workflow instead of inlining the loop in the parent?
   What do you gain in the UI, in retries, and in worker placement?
4. The agent's recommendation is advisory and a human still approves. Why keep the
   human gate even when the model is confident?

---

## Stuck?

Use the **Switch to solution** toggle to compare `agent-workflow.ts` and
`workflows.ts` with working answers.

Done? Try the optional [saga / compensation stretch](../STRETCH-saga.md).
