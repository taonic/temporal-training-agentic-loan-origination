# Module 2 · Signals & Queries — human in the loop (20 min)

> **Prefer your browser?** You can complete this entire workshop with zero local setup at
> **[temporal-training-agentic-loan-origination.fly.dev](https://temporal-training-agentic-loan-origination.fly.dev)** —
> a browser-based runtime with a live Temporal sandbox. This guide covers running it locally instead.

**Goal:** pause the workflow for a human decision, *inspect* it while it waits with
a **query**, and *drive it forward* with a **signal** — entirely on your machine,
no internet or API keys.

**Time:** ~20 min · **You'll edit:** `starter/src/workflows.ts`.

No LLM here, so the offline setup is just the Temporal dev server, your worker, and
the `temporal` CLI for signals/queries. (One-time offline setup is in the
[root README](../README.md#run-it-offline-on-your-machine).) This module's starter
contains the Module 1 solution, so the pipeline already runs — you add the approval
gate on top.

You'll use **three terminals**, all from the repo root.

---

## Step 0 — Start the Temporal dev server

In **Terminal 1**:

```bash
temporal server start-dev
```

✓ **Checkpoint:** **http://localhost:8233** loads. Leave it running.

---

## Step 1 — Define the query and signals

Open [starter/src/workflows.ts](./starter/src/workflows.ts). At **module scope**
(outside the function), declare a query and two signals, and import `defineQuery`,
`defineSignal`, `setHandler`, and `condition` from `@temporalio/workflow` (plus
`CancelRequest` from `./models`):

```ts
export const getStateQuery = defineQuery<LoanState>('getState');
export const approvalSignal = defineSignal<[]>('approveApplication');
export const rejectSignal = defineSignal<[CancelRequest]>('rejectApplication');
```

**Why:** a query is a read-only peek at state; a signal is an async message that
drives the workflow forward.

---

## Step 2 — Track the decision and attach handlers

Inside the workflow function, add two flags and wire up the handlers:

```ts
let approved = false;
let rejected = false;

setHandler(getStateQuery, () => ({ ...state }));
setHandler(approvalSignal, () => { approved = true; });
setHandler(rejectSignal, (req: CancelRequest) => {
  rejected = true;
  state.rejectReason = req.reason || 'No reason provided';
});
```

**Why:** the query handler returns a *defensive copy* (`{ ...state }`) so callers
can't mutate live workflow state.

---

## Step 3 — Pause until a human decides

After underwriting, park at `PENDING_APPROVAL` and block on a flag:

```ts
state.status = 'PENDING_APPROVAL';
await condition(() => approved || rejected);

if (rejected) {
  state.status = 'REJECTED';
} else {
  state.completedActivities.push('humanApproval');
  state.status = 'APPROVED';
}
```

**Why:** `condition(predicate)` durably suspends the workflow — seconds or months —
until the predicate is true. That's how you wait for a human.

---

## Step 4 — Run it

```bash
# Terminal 2 — worker (re-run after every code change)
npx ts-node module-2-signals-queries/starter/src/worker.ts

# Terminal 3 — start a loan
npx ts-node module-2-signals-queries/starter/src/client.ts
```

✓ **Checkpoint:** `LOAN-SIGNALS-001` runs the pipeline, then sits at `PENDING_APPROVAL` in
the UI (http://localhost:8233).

---

## Step 5 — Query and signal from the CLI (fully offline)

While `LOAN-SIGNALS-001` is paused:

```bash
# read live state without affecting the workflow
temporal workflow query --workflow-id LOAN-SIGNALS-001 --type getState

# approve it → APPROVED → workflow completes
temporal workflow signal --workflow-id LOAN-SIGNALS-001 --name approveApplication

# ...or reject it with a reason → REJECTED
temporal workflow signal --workflow-id LOAN-SIGNALS-001 --name rejectApplication \
  --input '{"reason":"Policy exception"}'
```

✓ **Checkpoint:** after the signal, the workflow reaches **Completed**. You can do
all of this from the Temporal Web UI too.

---

## Step 6 — Witness durability (it waits through a crash)

The pause at `condition()` is durable state in the Temporal service, not a thread
in memory:

1. Start a loan and let it park at `PENDING_APPROVAL`.
2. **Kill the worker** (Ctrl-C in Terminal 2). The workflow is still **Running** in
   the UI — no worker is even needed while it waits.
3. **Restart the worker**, then send `approveApplication`.

✓ **Observe:** the workflow resumes and completes. It would have waited like that
for months, across deploys and restarts.

---

## Concepts

- **Query** — a read-only peek at workflow state. Never mutates anything.
- **Signal** — an asynchronous message *into* a running workflow that drives it
  forward.
- **`condition(predicate)`** — durably suspends the workflow until the predicate is
  true. The canonical way to wait for out-of-band human action.

---

## Questions to ponder

Take a moment to consolidate what you learned:

1. The workflow parks at `condition(() => approved || rejected)`, possibly for
   weeks. Where does that pending state live?
2. What's the difference between delivering the approval as a **signal** versus
   passing it as a workflow argument at start time?
3. A signal arrives while the worker is down (Step 6). How does the workflow still
   process it once the worker returns?

---

## Stuck?

See [solution/src/workflows.ts](./solution/src/workflows.ts).

**Next:** [Module 3 · The recoverable pattern](../module-3-recoverable/README.md)
