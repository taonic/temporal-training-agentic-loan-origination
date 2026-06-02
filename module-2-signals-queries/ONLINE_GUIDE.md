# Module 2 · Signals & Queries — human in the loop

**Goal:** pause the workflow for a human decision, *inspect* it while it waits
with a **query**, and *drive it forward* with a **signal** — all from the
Temporal UI.

**Time:** ~20 min · **You'll edit:** the `workflows.ts` tab.

This module's starter already contains the Module 1 solution, so the three-activity
pipeline runs; you're adding the approval gate on top. The panel on the **left** is
the editor; hit **Run** in the dock, then use the **Temporal UI** button to query
and signal your workflow.

---

## Step 1 — Define the query and signals

Open the **`workflows.ts`** tab. At **module scope** (outside the function), declare
a query and two signals, and import `defineQuery`, `defineSignal`, `setHandler`, and
`condition` from `@temporalio/workflow` (plus `CancelRequest` from `./models`):

```ts
export const getStateQuery = defineQuery<LoanState>('getState');
export const approvalSignal = defineSignal<[]>('approveApplication');
export const rejectSignal = defineSignal<[CancelRequest]>('rejectApplication');
```

**Why:** these are typed *channels*. A query is a read-only peek at workflow state;
a signal is an asynchronous message that drives the workflow forward.

---

## Step 2 — Track the decision and attach handlers

Inside the workflow function, add two flags and wire up the handlers — the query
returns a snapshot, the signals flip the flags (reject also stores its reason):

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

**Why:** `setHandler` registers the callbacks. The query handler returns a
*defensive copy* (`{ ...state }`) so a caller can never mutate live workflow state.

---

## Step 3 — Pause until a human decides

After underwriting, set the status to `PENDING_APPROVAL` and **block** until one of
the flags flips:

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

**Why:** `condition(predicate)` durably suspends the workflow until the predicate
becomes true — seconds or months, consuming no resources while it waits. This is
how a workflow waits for a human.

---

## Step 4 — Run it

Hit **Run**. The pipeline executes, then the workflow parks at `PENDING_APPROVAL`.

✓ **Checkpoint:** the console shows the loan submitted. Open the **Temporal UI**
button and click into `LOAN-001` — it's **Running**, sitting at the approval gate.

---

## Step 5 — Query and signal from the Temporal UI

Click the **Temporal UI** button and open the running workflow **`LOAN-001`**. Both
actions below live in the workflow page's actions menu, **top-right** (under
*Workflow Actions*).

**Query the live state (read-only):** choose **Query**, pick the **`getState`**
query type, and submit — you read the current `LoanState` without changing anything.

**Drive it forward with a signal:** choose **Send a Signal**. In the dialog set the
**Signal name** and **input**:

- **Approve:** name `approveApplication`, input left empty → the workflow advances
  to `APPROVED` and **completes**.
- **Reject:** name `rejectApplication`, input `{ "reason": "Policy exception" }` →
  the workflow completes as `REJECTED`.

Click **Send a Signal** to submit.

✓ **Checkpoint:** the workflow reaches **Completed** — and confetti fires. (The
runner watches your workflow finish and celebrates when it does.)

---

## Step 6 — Witness durability (it waits through a crash)

The pause at `condition()` isn't a thread blocked in memory — it's durable state in
the Temporal service. Prove it:

1. Hit **Run** and let it park at `PENDING_APPROVAL`.
2. Click the **■** (stop) button next to the **`worker.ts`** tab to kill the worker.
3. In the Temporal UI the workflow is still **Running**, patiently waiting — a
   worker isn't even needed while it's parked.
4. Click **▶** to bring the worker back, then send `approveApplication`.

✓ **Observe:** the workflow resumes and completes (confetti). It would have waited
like that for months, across deploys and restarts — durable execution applied to a
human-in-the-loop pause.

---

## Concepts

- **Query** — a read-only peek at workflow state. Never mutates anything.
- **Signal** — an asynchronous message *into* a running workflow that drives it
  forward (approve / reject here).
- **`condition(predicate)`** — durably suspends the workflow until the predicate is
  true. The canonical way to wait for out-of-band human action.

---

## Questions to ponder

Take a moment to consolidate what you learned:

1. The workflow parks at `condition(() => approved || rejected)`, possibly for
   weeks. Where does that pending state live?
2. A signal arrives while the worker is down (Step 6). How does the workflow still
   end up processing it once the worker returns?

---

## Stuck?

Use the **Switch to solution** toggle (top-right of the editor) to compare your
code with a working answer, then switch back.
