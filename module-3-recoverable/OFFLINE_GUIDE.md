# Module 3 · The recoverable pattern (offline / local)

**Goal:** when an activity fails on bad data, *pause* the workflow, let a human fix
the data with a **signal**, and **retry** — instead of failing the whole loan.
Entirely on your machine, no internet or keys.

**Time:** ~20 min · **You'll edit:** `starter/src/workflows.ts`.

No LLM here, so the offline setup is just the Temporal dev server, your worker, and
the `temporal` CLI. (One-time setup: [root README](../README.md#run-it-offline-on-your-machine).)
This module's starter contains the Module 2 solution (query + approval).

You'll use **three terminals**, all from the repo root.

---

## Step 0 — Start the Temporal dev server

In **Terminal 1**:

```bash
temporal server start-dev
```

✓ **Checkpoint:** **http://localhost:8233** loads. Leave it running.

---

## Step 1 — Add a retry signal

Open [starter/src/workflows.ts](./starter/src/workflows.ts). Declare a `retry`
signal at module scope (import `RetryUpdate` from `./models`):

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

**Why:** the signal carries the *fix* (the corrected SSN) into the running workflow.

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

**Why:** `ApplicationFailure.nonRetryable` means "a human must intervene." The
`try/catch` + `condition` turns that into a durable pause-and-resume.

---

## Step 3 — Wrap each forward activity

```ts
await recoverableStep('verifyIncome', () =>
  verifyIncome(app.applicantName, app.employerName, app.annualIncome));
await recoverableStep('runCreditCheck', () =>
  runCreditCheck(app.applicantName, app.ssn));
await recoverableStep('underwrite', () =>
  underwrite(app.applicantName, app.annualIncome, app.loanAmount, app.downPayment));
```

---

## Step 4 — Run it (the failing scenario)

Start the **bad-ssn** scenario — its credit check fails on purpose:

```bash
# Terminal 2 — worker
npx ts-node module-3-recoverable/starter/src/worker.ts

# Terminal 3 — start a loan whose SSN is invalid
npx ts-node module-3-recoverable/starter/src/client.ts bad-ssn
```

✓ **Checkpoint:** `LOAN-002` stops at `PENDING_FIX` on `runCreditCheck` (in the UI
at http://localhost:8233). It did **not** fail outright.

---

## Step 5 — Fix it, then approve, from the CLI (fully offline)

```bash
# patch the bad SSN → retries the credit check and continues the pipeline
temporal workflow signal --workflow-id LOAN-002 --name retry \
  --input '{"key":"ssn","value":"222-33-4444"}'

# the loan then parks at PENDING_APPROVAL (Module 2's gate) — approve it
temporal workflow signal --workflow-id LOAN-002 --name approveApplication
```

✓ **Checkpoint:** the workflow reaches **Completed**. The fix is recorded in
`fixHistory` — see it with `temporal workflow query --workflow-id LOAN-002 --type getState`.

---

## Step 6 — Witness durability (the paused fix survives a crash)

1. Run the `bad-ssn` scenario and let it park at `PENDING_FIX`.
2. **Kill the worker** (Ctrl-C in Terminal 2) — the workflow stays **Running**,
   still waiting for its fix.
3. **Restart the worker**, then send the `retry` signal (and then
   `approveApplication`).

✓ **Observe:** the half-finished, *broken* loan resumes from exactly where it
paused and completes — across a worker crash.

---

## Concepts

- **`ApplicationFailure.nonRetryable(...)`** — tells Temporal *"don't auto-retry,
  this needs human input"* (vs ordinary errors, which Temporal retries automatically).
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
   state from a signal handler safe, but calling a database from one wouldn't be?
4. After the fix, the credit check runs *again*. If it had partially succeeded
   before failing, what would protect you from doing its work twice?

---

## Stuck?

See [solution/src/workflows.ts](./solution/src/workflows.ts).

**Next:** [Module 4 · A durable AI agent](../module-4-ai-agent/OFFLINE_GUIDE.md)
