# Module 3 · The recoverable pattern

**Goal:** when an activity fails on bad data, *pause* the workflow, let a human fix
the data with a **signal**, and **retry** — instead of failing the whole loan.

**Time:** ~20 min · **You'll edit:** the `workflows.ts` tab.

**Run** here submits the **`bad-ssn`** scenario (`LOAN-RECOVERY-002`) on purpose: its SSN is
invalid, so the credit check throws `ApplicationFailure.nonRetryable(...)`. With the
starter code that just **fails** the workflow. Your job is to make it pause and wait
for a fix. This module's starter contains the Module 2 solution (query + approval).

---

## Step 1 — Declare the retry signal

Open the **`workflows.ts`** tab. First, add `LoanStatus` and `RetryUpdate` to the
existing `./models` import:

```ts
import type {
  LoanApplication,
  LoanState,
  LoanStatus,
  RetryUpdate,
} from './models';
```

Then declare the signal at module scope, next to the other signals:

```ts
// The retry signal carries a field patch to fix bad data.
export const retrySignal = defineSignal<[RetryUpdate]>('retry');
```

**Why:** this signal is how the human's *fix* (the corrected SSN) gets into the
running workflow. Its payload, `RetryUpdate`, is just `{ key, value }` — which field
to patch and its new value.

---

## Step 2 — Fill in the workflow body

Inside the workflow, find the `// TODO` comment block (between the existing signal
handlers and the `await verifyIncome(...)` calls). Delete the whole TODO block and
paste these three chunks in its place, in order.

### 2a — The retry flag and handler (where the fix is applied)

```ts
  let retryRequested = false;

  // The retry signal patches one field on the application, then unblocks the
  // recoverable step that's currently waiting.
  setHandler(retrySignal, (update: RetryUpdate) => {
    if (update.key) {
      const key = update.key as keyof LoanApplication;
      const oldValue = String(app[key]);
      if (key === 'annualIncome' || key === 'loanAmount' || key === 'downPayment') {
        (app[key] as number) = parseFloat(update.value ?? '0');
      } else {
        (app[key] as string) = update.value ?? '';
      }
      state.fixHistory.push({
        activity: state.failedActivity,
        field: key,
        oldValue,
        newValue: update.value ?? '',
        error: state.failureMessage,
      });
      log.info(`Fix received ${key}: ${oldValue} -> ${update.value}`);
    }
    retryRequested = true;
  });
```

This is the heart of the module. When the `retry` signal arrives it patches one field
on `app` (numbers like `annualIncome` are parsed; everything else is a string), and
`retryRequested = true` releases the paused step.

The `state.fixHistory.push({...})` call is the audit trail: **before** overwriting the
field, we capture `oldValue`, then record what changed and *why* — `state.failedActivity`
and `state.failureMessage` tell us which step failed and with what error. (Those two are
kept up to date by `setStatus`, which you add next.) `getState` later surfaces this
`fixHistory` so you can see every human correction the loan needed.

### 2b — The setStatus helper

```ts
  const setStatus = (status: LoanStatus, activity = '', message = '') => {
    state.status = status;
    state.failedActivity = activity;
    state.failureMessage = message;
  };
```

One place to update the status **and** remember which activity failed and why. The
handler in 2a reads `state.failedActivity` / `state.failureMessage` when it records a
fix — this helper is what keeps them current.

### 2c — The recoverableStep helper

```ts
  const recoverableStep = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    while (true) {
      try {
        return await fn();
      } catch (e: any) {
        const message = e.cause?.message || e.message || String(e);
        log.warn(`${name} failed: ${message}`);
        setStatus('PENDING_FIX', name, message);
        retryRequested = false;
        await condition(() => retryRequested);
        setStatus('STARTED');
        log.info(`Retrying ${name}`);
      }
    }
  };
```

Run the activity; if it throws, set status to `PENDING_FIX` (recording the failure),
then **wait** with `condition(() => retryRequested)` until the handler in 2a flips the
flag. Then loop and try again with the patched data. The loan never fails outright — a
human just nudges it forward.

**Why:** `ApplicationFailure.nonRetryable` means *"don't auto-retry — a human must
intervene."* The `try/catch` + `condition` turns that into a durable pause-and-resume.

---

## Step 3 — Wrap the forward pipeline

Now make the pipeline use those helpers. Replace everything from the first
`await verifyIncome(...)` down through `return state;` with:

```ts
  await recoverableStep('verifyIncome', () =>
    verifyIncome(app.applicantName, app.employerName, app.annualIncome)
  );
  state.completedActivities.push('verifyIncome');
  setStatus('INCOME_VERIFIED');

  await recoverableStep('runCreditCheck', () => runCreditCheck(app.applicantName, app.ssn));
  state.completedActivities.push('runCreditCheck');
  setStatus('CREDIT_CHECKED');

  await recoverableStep('underwrite', () =>
    underwrite(app.applicantName, app.annualIncome, app.loanAmount, app.downPayment)
  );
  state.completedActivities.push('underwrite');
  setStatus('UNDERWRITTEN');

  setStatus('PENDING_APPROVAL');
  await condition(() => approved || rejected);

  if (rejected) {
    setStatus('REJECTED');
  } else {
    state.completedActivities.push('humanApproval');
    setStatus('APPROVED');
  }

  return state;
```

Each forward activity now runs inside `recoverableStep`, and the status transitions go
through `setStatus` so a failure cleanly records *which* step paused.

---

## Step 4 — Run it

Hit **Run**. `LOAN-RECOVERY-002` stops at `PENDING_FIX` on `runCreditCheck` (bad SSN).

✓ **Checkpoint:** open the **Temporal UI** button → `LOAN-RECOVERY-002` is **Running**,
parked at the failed credit check. It did **not** fail outright.

---

## Step 5 — Fix it, then approve, from the Temporal UI

Click the **Temporal UI** button and open the running workflow **`LOAN-RECOVERY-002`**. Both
steps use the workflow page's actions menu, **top-right** (under *Workflow Actions*)
→ **Send a Signal**:

1. **Fix the data:** Signal name `retry`, input:
   ```json
   { "key": "ssn", "value": "222-33-4444" }
   ```
   The workflow patches the SSN, retries the credit check, and continues the
   pipeline — then parks at `PENDING_APPROVAL` (the gate you built in Module 2).
2. **Approve it:** Signal name `approveApplication`, input left empty.

✓ **Checkpoint:** the workflow reaches **Completed** — confetti. The fix is recorded
in `fixHistory` (run the `getState` query to see it). A normal error would have been
auto-retried; `nonRetryable` is what lets you wait for human input instead.

---

## Step 6 — Witness durability (the paused fix survives a crash)

1. Run it and let `LOAN-RECOVERY-002` park at `PENDING_FIX`.
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
