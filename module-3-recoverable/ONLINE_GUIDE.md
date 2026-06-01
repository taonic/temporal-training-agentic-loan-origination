# Module 3 · The recoverable pattern

**Goal:** when an activity fails on bad data, *pause* the workflow, let a human
fix the data with a signal, and retry — instead of failing the whole loan.

**Run** here submits the **`bad-ssn`** scenario (`LOAN-002`) on purpose: its SSN
is invalid, so the credit check throws `ApplicationFailure.nonRetryable(...)`.
With the starter code that just **fails** the workflow. Your job is to make it
pause and wait for a fix.

This module's starter already contains the Module 2 solution (query + approval).

## Step 1 — Add a retry signal

Open the **`workflows.ts`** tab. Add a `retryRequested` flag and a `retry` signal
whose handler patches one field on the application (parsing numbers for
`annualIncome` / `loanAmount` / `downPayment`), records a `FixEntry` on
`state.fixHistory`, and sets `retryRequested = true`:

```ts
export const retrySignal = defineSignal<[RetryUpdate]>('retry');
// ...inside the workflow:
let retryRequested = false;
setHandler(retrySignal, (update: RetryUpdate) => {
  // patch app[update.key], push onto state.fixHistory...
  retryRequested = true;
});
```

Import `RetryUpdate` (and any status types) from `./models`.

## Step 2 — Write the recoverable helper

Wrap an activity call so a non-retryable failure pauses instead of crashing:

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

## Step 4 — Fix it from the Temporal UI

Hit **Run**. `LOAN-002` will stop at `PENDING_FIX` on `runCreditCheck` (bad SSN).
Open the **Temporal UI** button, click into `LOAN-002`, and **Send a Signal**
named `retry` with this input:

```json
{ "key": "ssn", "value": "222-33-4444" }
```

Watch the workflow resume, pass the credit check, and finish the pipeline — the
fix is recorded in `fixHistory`. A normal error would have been auto-retried;
`nonRetryable` is what lets you wait for human input instead.

## Stuck?

Toggle **Switch to solution** to compare with a working answer.
