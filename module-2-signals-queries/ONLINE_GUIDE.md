# Module 2 · Signals & Queries — human in the loop

**Goal:** pause the workflow for a human decision, inspect it while it waits, and
drive it forward from the outside — all from the Temporal UI.

This module's starter already contains the Module 1 solution, so the pipeline
runs; you're adding the approval gate on top.

## Step 1 — Define the query and signals

Open the **`workflows.ts`** tab. At **module scope** (outside the function), add
a query and two signals, and import `defineQuery`, `defineSignal`, `setHandler`,
and `condition` from `@temporalio/workflow` (plus `CancelRequest` from `./models`):

```ts
export const getStateQuery = defineQuery<LoanState>('getState');
export const approvalSignal = defineSignal<[]>('approveApplication');
export const rejectSignal = defineSignal<[CancelRequest]>('rejectApplication');
```

## Step 2 — Track the decision and attach handlers

Inside the workflow function, add two flags and wire up the handlers. The query
returns a snapshot of state; the signals flip the flags (reject also stores its
reason):

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

## Step 3 — Pause until a human decides

After underwriting, set the status to `PENDING_APPROVAL` and **block** until one
of the flags flips. `condition` durably suspends the workflow — it can wait
seconds or months without consuming resources:

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

## Step 4 — Drive it from the Temporal UI

Hit **Run**, then open the **Temporal UI** button and click into `LOAN-001`. It
will be sitting at `PENDING_APPROVAL`.

- **Query** the live state: in the workflow page, run the **`getState`** query —
  you'll read the state without changing anything.
- **Approve it:** use **Send a Signal** with the name `approveApplication`. Watch
  the workflow advance to `APPROVED` and complete.
- **Or reject it:** send `rejectApplication` with input
  `{ "reason": "Policy exception" }`.

## Stuck?

Toggle **Switch to solution** to compare with a working answer.
