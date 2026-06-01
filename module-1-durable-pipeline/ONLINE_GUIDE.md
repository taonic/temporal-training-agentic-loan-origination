# Module 1 · A durable pipeline

**Goal:** run three activities in sequence, then watch the workflow survive a
worker crash — the whole point of Temporal.

Everything runs in the browser: edit the code on the left, hit **Run**, and a
fresh Temporal dev server + your worker spin up in a sandbox. Open the
**Temporal UI** button after a run to inspect the workflow's event history.

## Step 1 — Read the activities

Open the **`activities.ts`** tab. The three activities are already written:
`verifyIncome`, `runCreditCheck`, and `underwrite`. Each just simulates ~2.5s of
work and returns a string. You'll orchestrate them from the workflow — you won't
edit this file.

## Step 2 — Call the activities in order

Open the **`workflows.ts`** tab and fill in the `// TODO` block. `await` each
activity in sequence, and after each one push its name onto
`state.completedActivities` and advance `state.status`:

```ts
await verifyIncome(app.applicantName, app.employerName, app.annualIncome);
state.completedActivities.push('verifyIncome');
state.status = 'INCOME_VERIFIED';

await runCreditCheck(app.applicantName, app.ssn);
state.completedActivities.push('runCreditCheck');
state.status = 'CREDIT_CHECKED';

await underwrite(app.applicantName, app.annualIncome, app.loanAmount, app.downPayment);
state.completedActivities.push('underwrite');
state.status = 'UNDERWRITTEN';
```

Your edits are saved in your browser automatically.

## Step 3 — Run it

Hit the **Run** button in the dock below the editor. It provisions the sandbox,
starts your worker, and submits loan `LOAN-001`. When the console shows the run
finished, click the **Temporal UI** button and open `LOAN-001` — you'll see each
activity appear in the event history.

## Step 4 — Witness durable execution

This is the lesson. Start a run, then **while the activities are still running**:

1. Click the **■** (stop) button next to the **`worker.ts`** tab to kill the worker.
2. Refresh the workflow in the Temporal UI — it is **not failed**, just waiting.
3. Click the **▶** (start) button next to the **`worker.ts`** tab to bring the
   worker back.

The workflow resumes exactly where it left off — no lost progress, no duplicated
work. Each `await` is a checkpoint in history; a restarted worker replays that
history to rebuild state.

## Stuck?

Use the **Switch to solution** toggle (top-right of the editor) to compare your
code with a working answer, then switch back.
