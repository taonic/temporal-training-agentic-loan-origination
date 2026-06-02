# Module 3 · The recoverable pattern

**Goal:** when an activity fails on bad data, *pause* the workflow, let a human fix
the data with a **signal**, and **retry** — instead of failing the whole loan.

**Time:** ~20 min · **You'll edit:** the `workflows.ts` tab.

**Run** here submits the **`bad-ssn`** scenario (`LOAN-002`) on purpose: its SSN is
invalid, so the credit check throws `ApplicationFailure.nonRetryable(...)`. With the
starter code that just **fails** the workflow. Your job is to make it pause and wait
for a fix. This module's starter contains the Module 2 solution (query + approval).

---

## Step 1 — Add a retry signal

Open the **`workflows.ts`** tab. Declare a `retry` signal at module scope and import
`RetryUpdate` from `./models`:

```ts
export const retrySignal = defineSignal<[RetryUpdate]>('retry');
```

Inside the workflow, add a `retryRequested` flag and a handler that patches one
field on the application (parsing numbers for `annualIncome` / `loanAmount` /
`downPayment`), records a `FixEntry` on `state.fixHistory`, then unblocks the wait:

```ts
let retryRequested = false;
setHandler(retrySignal, (update: RetryUpdate) => {
  // patch app[update.key], push onto state.fixHistory...
  retryRequested = true;
});
```

**Why:** the signal carries the *fix* from a human (the corrected SSN) into the
running workflow.

---

## Step 2 — Write the recoverable helper

Wrap an activity call so a non-retryable failure **pauses** instead of crashing:

```ts
const recoverableStep = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  while (true) {
    try {
      return await fn();
    } catch (e: any) {
      setStatus('PENDING_FIX', name, e.cause?.message || e.message || String(e));
      retryRequested = false;
      await condition(() => retryRequested);   // wait for the fix
      setStatus('STARTED');                     // then loop and retry
    }
  }
};
```

**Why:** `ApplicationFailure.nonRetryable` means "don't auto-retry — a human must
intervene." The `try/catch` + `condition` turns that into a durable pause-and-resume.

---

## Step 3 — Wrap each forward activity

Replace the three direct activity calls with `recoverableStep(...)`:

```ts
await recoverableStep('verifyIncome', () =>
  verifyIncome(app.applicantName, app.employerName, app.annualIncome));
await recoverableStep('runCreditCheck', () =>
  runCreditCheck(app.applicantName, app.ssn));
await recoverableStep('underwrite', () =>
  underwrite(app.applicantName, app.annualIncome, app.loanAmount, app.downPayment));
```

---

## Step 4 — Run it

Hit **Run**. `LOAN-002` stops at `PENDING_FIX` on `runCreditCheck` (bad SSN).

✓ **Checkpoint:** open the **Temporal UI** button → `LOAN-002` is **Running**,
parked at the failed credit check. It did **not** fail outright.

---

## Step 5 — Fix it, then approve, from the Temporal UI

1. **Send a Signal** named `retry` with this input:
   ```json
   { "key": "ssn", "value": "222-33-4444" }
   ```
   The workflow patches the SSN, retries the credit check, and continues the
   pipeline — then parks at `PENDING_APPROVAL` (the gate you built in Module 2).
2. **Send a Signal** named `approveApplication` to approve it.

✓ **Checkpoint:** the workflow reaches **Completed** — confetti. The fix is recorded
in `fixHistory` (query `getState` to see it). A normal error would have been
auto-retried; `nonRetryable` is what lets you wait for human input instead.

---

## Step 6 — Witness durability (the paused fix survives a crash)

1. Run it and let `LOAN-002` park at `PENDING_FIX`.
2. Click **■** next to **`worker.ts`** to kill the worker — the workflow stays
   **Running** in the UI, still waiting for its fix.
3. Click **▶** to restart the worker, then send the `retry` signal (and then
   `approveApplication`).

✓ **Observe:** the workflow resumes from exactly where it paused and completes. The
half-finished, *broken* loan waited safely for a human — across a worker crash.

---

## Concepts

- **`ApplicationFailure.nonRetryable(...)`** — tells Temporal *"don't auto-retry,
  this needs human input"* (contrast with normal errors, which Temporal retries
  per the activity's retry policy).
- **Pause-and-resume** — `condition` + a signal is the canonical way to block on
  out-of-band human action and continue deterministically afterward.
- **The loop is in your code** — `recoverableStep` is plain control flow; Temporal
  makes each iteration durable.

---

## Questions to ponder

Take a moment to consolidate what you learned:

1. Why does `recoverableStep` retry in a `while (true)` loop rather than relying on
   the activity's built-in retry policy? When is each approach the right one?
2. What distinguishes a **non-retryable** failure (bad SSN) from an ordinary one
   (a flaky network call)? Who should fix each?
3. The fix arrives as a `retry` signal that mutates `app`. Why is mutating workflow
   state from a signal handler safe here, but calling a database from one wouldn't be?
4. After the fix, the credit check runs *again*. If `runCreditCheck` had already
   partially succeeded before failing, what would protect you from doing its work twice?

---

## Stuck?

Use the **Switch to solution** toggle (top-right of the editor) to compare with a
working answer, then switch back.
