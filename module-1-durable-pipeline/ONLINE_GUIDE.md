# Module 1 · A durable pipeline

**Goal:** run three activities in sequence, then watch the workflow **survive a
worker crash** — the whole point of Temporal.

**Time:** ~20 min · **You'll edit:** the `workflows.ts` tab (one `// TODO` block).

Everything runs in your browser — no install, no keys. The panel on the **left**
is a code editor with this module's files as tabs; this guide is on the **right**.
The **dock** below the editor has a **Run** button and, after a run, a **Temporal
UI** button that opens the live event history in a new tab.

---

## Step 1 — Read the activities (don't edit them)

Open the **`activities.ts`** tab. The three activities are already written — your
job is to *orchestrate* them from the workflow, not to change them:

| Activity | Call signature | Returns |
|----------|----------------|---------|
| `verifyIncome` | `(applicantName, employerName, annualIncome)` | `"Income verified: …"` |
| `runCreditCheck` | `(applicantName, ssn)` | `"Credit check passed … score 750"` |
| `underwrite` | `(applicantName, annualIncome, loanAmount, downPayment)` | `"Underwriting approved … DTI …%"` |

Each one sleeps ~2.5s (so the pipeline is visible in the UI) and returns a string.
That deliberate delay is also what gives you a window to crash the worker in Step 4.

---

## Step 2 — Call the activities in order

Open the **`workflows.ts`** tab. The activities are already wired as callable
stubs at the top of the file via `proxyActivities`. Find the `// TODO` block inside
`homeLoanWorkflow` (just after `const app = state.application;`) and replace it
with:

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

What each line does:

- **`await verifyIncome(...)`** schedules the activity; a worker runs it and the
  result is recorded in history. Each `await` is a **durable checkpoint** — the
  key to Step 4.
- **`state.completedActivities.push(...)`** and **`state.status = ...`** update the
  workflow's state (which a query can read — you'll add that in Module 2).

Your edits autosave in the browser.

---

## Step 3 — Run it

Hit **Run** in the dock. It provisions a sandbox, starts your worker, and submits
loan `LOAN-001`.

✓ **Checkpoint:** the console shows the worker starting and `LOAN-001` being
submitted. Click the **Temporal UI** button, open `LOAN-001`, and over ~8 seconds
the **History** tab fills with three `ActivityTaskCompleted` events — one per
activity. The workflow finishes as **Completed**, and its result shows
`status: 'UNDERWRITTEN'` with all three names in `completedActivities`.

> Workflow **completes instantly with no activity events**? The `// TODO` block
> wasn't filled in. Re-check Step 2 (make sure your code replaced the TODO inside
> `homeLoanWorkflow`) and hit **Run** again.

---

## Step 4 — Witness durable execution (the whole point)

This is the lesson. Break it on purpose and watch Temporal shrug it off.

1. Hit **Run** to start a fresh loan.
2. **While the activities are still running** (~8s window), click the **■** (stop)
   button next to the **`worker.ts`** tab to kill the worker.
3. Refresh `LOAN-001` in the Temporal UI.
   ✓ **Observe:** the workflow is **not failed** — it's just *waiting*. The
   activities that finished are recorded; the rest are pending.
4. Click the **▶** (start) button next to the **`worker.ts`** tab to bring the
   worker back.
   ✓ **Observe:** the workflow **resumes exactly where it left off** — no lost
   progress, no activity that already finished re-runs — and completes at
   `UNDERWRITTEN`.

That's *durable execution*: your business logic survives process crashes, deploys,
and machine restarts for free. Each `await` recorded a checkpoint in history; the
restarted worker replayed that history to rebuild state and carried on.

---

## Concepts

- **Workflow** — your durable orchestration code (`homeLoanWorkflow`). Must be
  deterministic, so it can be replayed from history.
- **Activity** — one unit of work that may have side effects (I/O, clocks,
  randomness). Its result is recorded so replay stays deterministic.
- **`proxyActivities`** — turns activity functions into stubs that run on a worker
  via the task queue, with a retry/timeout policy attached.

---

## Questions to ponder

Take a moment to consolidate what you learned:

1. When you killed the worker mid-pipeline, the workflow didn't fail or lose
   progress. Where does that in-progress state actually live, and what does a
   restarted worker do to rebuild it?
2. Each `await` on an activity is a "durable checkpoint." What gets written to
   history at that point, and why does that let the workflow survive a crash
   *between* two activities?
3. The workflow just `await`s three calls in order, yet they may run on a
   different worker process (or machine). What is `proxyActivities` doing behind
   that simple `await`?

---

## Stuck?

Use the **Switch to solution** toggle (top-right of the editor) to compare your
code with a working answer, then switch back.
