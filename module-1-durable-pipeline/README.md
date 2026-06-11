# Module 1 · A durable pipeline (20 min)

> **Prefer your browser?** You can complete this entire workshop with zero local setup at
> **[temporal-training-agentic-loan-origination.fly.dev](https://temporal-training-agentic-loan-origination.fly.dev)** —
> a browser-based runtime with a live Temporal sandbox. This guide covers running it locally instead.

**Goal:** run three activities in sequence, then watch the workflow **survive a
worker crash** — the whole point of Temporal. Everything here runs on your
machine with no internet and no API keys.

**Time:** ~20 min · **You'll edit:** `starter/src/workflows.ts` (one TODO block).

> New to the local setup? The one-time offline prerequisites (Node + the Temporal
> CLI) are in the [root README](../README.md#run-it-offline-on-your-machine).
> Module 1 has no LLM, so you do **not** need Docker or the qwen model here.

You'll use **three terminals**, all from the repo root. Open them now.

---

## Step 0 — Start the Temporal dev server

In **Terminal 1**:

```bash
temporal server start-dev
```

✓ **Checkpoint:** open **http://localhost:8233** — the Temporal Web UI loads with
an empty list of workflows. Leave this server running for the whole module.

---

## Step 1 — Read the activities (don't edit them)

Open [starter/src/activities.ts](./starter/src/activities.ts). The three
activities are already written — you'll *orchestrate* them, not change them:

| Activity | Call signature | Returns |
|----------|----------------|---------|
| `verifyIncome` | `(applicantName, employerName, annualIncome)` | `"Income verified: …"` |
| `runCreditCheck` | `(applicantName, ssn)` | `"Credit check passed … score 750"` |
| `underwrite` | `(applicantName, annualIncome, loanAmount, downPayment)` | `"Underwriting approved … DTI …%"` |

Each one returns a string. By default they run instantly
(`SIMULATED_PROCESSING_MS = 0` at the top of `activities.ts`), so the whole pipeline
finishes in a blink. In **Step 4** you'll bump that constant up to give yourself a
window to crash the worker mid-pipeline.

---

## Step 2 — Complete the workflow

Open [starter/src/workflows.ts](./starter/src/workflows.ts). You'll find a
`// TODO` block inside `homeLoanWorkflow`, just after `const app = state.application;`.

The activities are already wired as callable stubs at the top of the file via
`proxyActivities`. Your job: `await` each one **in order**, and after each, record
that it finished and advance the status. Replace the TODO block with:

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

- **`await verifyIncome(...)`** schedules the activity on the task queue; a worker
  runs it and the result is recorded in history. The `await` is a **durable
  checkpoint** — the lynchpin of Step 4.
- **`state.completedActivities.push(...)`** and **`state.status = ...`** update the
  workflow's in-memory state, which a query can read (you'll add that in Module 2).

Save the file. (No hot-reload — you'll start the worker fresh in the next step.)

---

## Step 3 — Run it

In **Terminal 2**, start the worker (re-run this after every code change —
Ctrl-C, then up-arrow, Enter):

```bash
npx ts-node module-1-durable-pipeline/starter/src/worker.ts
```

✓ **Checkpoint:** the worker prints
`Worker started on task queue "loan-workshop". Ctrl-C to exit.` and waits for work.

In **Terminal 3**, submit a loan application:

```bash
npx ts-node module-1-durable-pipeline/starter/src/client.ts
```

✓ **Checkpoint:** the client prints `Started LOAN-PIPELINE-001 (clean)` and a watch URL,
then exits right away — it *starts* the workflow without waiting for it. Open that
URL (or http://localhost:8233 → `LOAN-PIPELINE-001`) and watch: the
**History** tab shows three `ActivityTaskCompleted` events and the workflow
reaches **Completed** with status `UNDERWRITTEN`. (With the default
`SIMULATED_PROCESSING_MS = 0` this happens almost instantly.)

To read the final state from the CLI instead:

```bash
temporal workflow show --workflow-id LOAN-PIPELINE-001
```

> Workflow **completes instantly with no activity events** (status stays
> `STARTED`)? The TODO block wasn't filled in, or the worker wasn't restarted
> after editing. Redo Step 2, restart the worker, and submit again.

---

## Step 4 — Witness durable execution (the whole point)

Now break it on purpose and watch Temporal shrug it off.

First, give yourself a window to crash the worker: open `activities.ts` and change
the constant at the top from `SIMULATED_PROCESSING_MS = 0` to `2000`. Each activity
now sleeps ~2s, so the pipeline takes ~6s — long enough to kill and restart the
worker mid-run. Save, then restart the worker in **Terminal 2** so it picks up the change.

1. In **Terminal 3**, start a fresh run, then **immediately** switch to Terminal 2:
   ```bash
   npx ts-node module-1-durable-pipeline/starter/src/client.ts
   ```
2. While the activities are still running (you have ~6s), **kill the worker** in
   **Terminal 2** with **Ctrl-C**.
3. Open `LOAN-PIPELINE-001` in the Temporal UI and refresh.
   ✓ **Observe:** the workflow is **not failed** — it's just *waiting*. The
   activities completed so far are recorded; the rest are pending.
4. **Restart the worker** in Terminal 2:
   ```bash
   npx ts-node module-1-durable-pipeline/starter/src/worker.ts
   ```
   ✓ **Observe:** the workflow **resumes exactly where it left off** — no lost
   progress, no activity re-run that already finished — and completes at
   `UNDERWRITTEN`.

That's *durable execution*: your business logic survives process crashes, deploys,
and machine restarts for free. Each `await` recorded a checkpoint in history; the
restarted worker replayed that history to rebuild state and carried on.

---

## Concepts

- **Workflow** — your durable orchestration code (`homeLoanWorkflow`). Must be
  deterministic, so it can be replayed from history.
- **Activity** — one unit of work that may have side effects (I/O, clocks,
  randomness). Its result is recorded so the workflow's replay stays deterministic.
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

Compare with the complete answer in
[solution/src/workflows.ts](./solution/src/workflows.ts) — run it the same way,
swapping `starter` → `solution` in the paths.

**Next:** [Module 2 · Signals & Queries](../module-2-signals-queries/README.md)
