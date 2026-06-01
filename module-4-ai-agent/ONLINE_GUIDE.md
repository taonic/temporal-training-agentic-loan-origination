# Module 4 · A durable AI agent

**Goal:** run an LLM underwriter as a **child workflow** whose every model call
and tool call is a durable, replayable activity you can inspect in the UI.

This module's agent calls **OpenAI** through a shared proxy — your sandbox gets a
scoped key automatically, so there's nothing for you to configure. If the model is
ever unreachable, the workflow records an `ESCALATE` recommendation instead of
crashing, so the pipeline still finishes.

This module's starter contains the Module 3 solution. Two files matter:
**`agent-activities.ts`** (the LLM call + two mock tools — already written) and
**`agent-workflow.ts`** (the loop — your task).

## Step 1 — Write the tool-call loop

Open the **`agent-workflow.ts`** tab and replace the placeholder in the
`// TODO` block. For up to `MAX_TURNS`:

1. Call the LLM activity: `const resp = await callAgentLLM({ messages });`
2. Record the assistant's turn (its `text` + any `toolCalls`) onto `messages`.
3. If `resp.toolCalls.length === 0` the model is **done** — `parseRecommendation`
   the reply and `return` the structured recommendation (escalate if unparseable).
4. Otherwise **dispatch each tool** with `await dispatchTool(...)`, push the
   results back as a `tool` message, record them in `toolCallTrace`, and loop.

```ts
for (let turn = 1; turn <= MAX_TURNS; turn++) {
  const resp = await callAgentLLM({ messages });
  model = resp.model;
  // ...record assistant turn...
  if (resp.toolCalls.length === 0) {
    const parsed = parseRecommendation(resp.text);
    return { ...parsed, toolCallTrace, turns: turn, model, completedAt: new Date().toISOString() };
  }
  // ...dispatch each tool, push a 'tool' message, continue...
}
```

The **workflow** drives this loop — not the AI SDK — so each step becomes its own
durable checkpoint instead of one opaque black-box call.

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

## Step 3 — Watch the agent reason, durably

Hit **Run** (the first run provisions the sandbox, so give it a moment). Open the
**Temporal UI** button — you'll now see a **second workflow**, `LOAN-001-agent`,
with one activity per model turn and one per tool call (`lookupFullCreditReport`,
`checkComplianceWatchlist`). That's the agent's reasoning, made durable and
replayable: kill the worker mid-think and it resumes from the last recorded step.

## Stuck?

Toggle **Switch to solution** to compare `agent-workflow.ts` and `workflows.ts`
with working answers.
