<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { linter, lintGutter } from "@codemirror/lint";

import { launchConfetti } from "./confetti.js";
import Tour from "./Tour.vue";
import {
  labelForPath,
  renderMarkdown,
  splitWalkthrough,
  storageKey,
  storagePrefix,
} from "./course-utils.js";

function initialTheme() {
  const saved = localStorage.getItem(`${storagePrefix}:theme`);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const course = window.COURSE_DATA;

// Confetti fires when the workflow actually COMPLETES — which for modules that
// pause for a human signal is after the learner sends it (and after the worker
// restart in the durability demo). We long-poll the runner (which blocks on
// `temporal workflow result`) until the workflow closes, then celebrate once.
// A new run aborts any in-flight watch so we never celebrate a stale execution.
let completionPoll = null;
function startCompletionPoll(sandboxId, workflowId) {
  completionPoll?.abort();
  const controller = new AbortController();
  completionPoll = controller;
  (async () => {
    const deadline = Date.now() + 10 * 60 * 1000; // stop watching after 10 minutes
    while (!controller.signal.aborted && Date.now() < deadline) {
      let data;
      try {
        const res = await fetch("/api/await-result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sandboxId, workflowId }),
          signal: controller.signal,
        });
        data = await res.json();
      } catch (err) {
        if (err.name === "AbortError") return;
        await new Promise((r) => setTimeout(r, 3000)); // transient — back off, retry
        continue;
      }
      if (controller.signal.aborted || data.gone) return;
      if (data.completed) {
        if (completionPoll === controller) {
          // The run only ever put the client's "Started ..." stdout in the
          // Output tab; the workflow's actual result (the loan decision) isn't
          // known until it closes. Surface it here now that we have it.
          if (data.result) {
            state.workflowOutput = data.result;
            state.runnerPanel = "output";
          }
          try {
            launchConfetti();
          } catch {
            /* celebration is best-effort */
          }
        }
        return;
      }
      // Still running (the endpoint already long-polled ~55s) — poll again.
    }
  })();
}

const state = reactive({
  exerciseIndex: initialExerciseIndex(),
  theme: initialTheme(),
  activeFilePath: "",
  fileView: "exercise",
  toast: "",
  sandboxStatus: "checking",
  sandboxAvailable: false,
  sandboxMessage: "",
  sandboxId: localStorage.getItem(`${storagePrefix}:sandbox-id`) ?? "",
  temporalUiUrl: localStorage.getItem(`${storagePrefix}:temporal-ui-url`) ?? "",
  workflowId: "",
  // Right-hand drawer that embeds this workflow in the sandbox's Temporal Web UI.
  // Opens automatically once a run reports its workflow id (see handleRunnerEvent).
  workflowPaneOpen: false,
  // Tracks the pane iframe's load so we can cover the blank gap with a spinner until
  // the Temporal UI paints.
  paneFrameLoaded: false,
  paneWidth: localStorage.getItem(`${storagePrefix}:pane-width`) ?? "",
  // Where the runner's same-origin Temporal UI proxy lives. The runner reports an
  // explicit base, or a port we combine with this page's hostname (see embedUrl).
  uiProxyBase: "",
  uiProxyPort: 0,
  runnerPanel: "console",
  logs: [],
  spinner: "",
  // Latest server-side type-check result for the current module, shared by the
  // editor's inline markers and the pre-run gate.
  diagnostics: [],
  workflowOutput: "",
  workerBusy: false,
  starterBusy: false,
  workerActive: false,
  codeWidth: localStorage.getItem(`${storagePrefix}:code-width`) ?? "",
  dockHeight: localStorage.getItem(`${storagePrefix}:dock-height`) ?? "",
});

const editorValue = ref("");
const walkVersion = ref(0);

// Product tour for new visitors. It runs automatically the first time someone
// lands on the site (tracked in localStorage) and can be replayed any time from
// the topbar "Tour" button.
const tourSeenKey = `${storagePrefix}:tour-seen`;
const tourVisible = ref(false);
const tourSteps = [
  {
    title: "Welcome to Temporal Agentic Loan Origination",
    body: "A hands-on workshop where you edit real Temporal code and run it live in a sandbox — building a durable loan-origination workflow that finishes with an AI underwriting agent. Here's a 60-second tour.",
  },
  {
    selector: "[data-tour='exercise-picker']",
    title: "Pick a module",
    body: "Jump between the four modules here, or use Previous / Next. Each builds on the last, so the starter code already contains the previous module's solution.",
  },
  {
    selector: "[data-tour='editor']",
    title: "Edit the code",
    body: "This is your editor. Make changes to the workflow, activities, worker, and client — your edits are saved automatically in your browser.",
  },
  {
    selector: "[data-tour='file-tabs']",
    title: "Switch between files",
    body: "Each module has several source files. The ▶ / ■ buttons next to worker.ts and client.ts let you start the worker or start a loan application on its own.",
  },
  {
    selector: "[data-tour='instructions']",
    title: "Follow the instructions",
    body: "Step-by-step guidance lives here. Tick off steps as you go and track your progress at the top.",
  },
  {
    selector: "[data-tour='solution-toggle']",
    title: "Peek at the solution",
    body: "Stuck? Toggle the solution view to compare with a working answer, then switch back to your own code.",
  },
  {
    selector: "[data-tour='run']",
    title: "Run it for real",
    body: "Hit Run to spin up a live Temporal dev server in a sandbox, start the worker, and submit a loan application — output streams into the console below. Module 4 also boots a local qwen model for the AI agent.",
  },
  {
    selector: "[data-tour='runner-actions']",
    title: "Inspect and drive it in the Temporal UI",
    body: "After a run, a Temporal UI button appears here. Open it to explore the workflow's event history — and from Module 2 on, send approve / reject / retry signals straight from the Temporal Web UI to drive your paused workflow.",
  },
];

function startTour() {
  tourVisible.value = true;
}

function finishTour() {
  tourVisible.value = false;
  localStorage.setItem(tourSeenKey, "1");
}

const editorHostRef = ref(null);
let editorView = null;
const consoleRef = ref(null);

// Tailing pins the console to the newest output. We stop pinning the moment the
// user scrolls up to read earlier lines, and resume once they scroll back down.
let consolePinned = true;

function onConsoleScroll() {
  const el = consoleRef.value;
  if (!el) return;
  // A few px of slack so sub-pixel rounding never breaks the "at bottom" check.
  consolePinned = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
}
let toastTimer = 0;
// Each run kind owns its own abort controller so worker and starter runs are
// fully independent (one in flight never cancels or disables the other).
const runControllers = { worker: null, starter: null, all: null };

const themeToggleLabel = computed(() => (state.theme === "dark" ? "Light mode" : "Dark mode"));
const viewToggleLabel = computed(() =>
  state.fileView === "solution" ? "Switch to exercise" : "Switch to solution",
);

const currentExercise = computed(() => course.exercises[state.exerciseIndex]);
const currentFiles = computed(() => currentExercise.value?.files ?? []);
const hasSolution = computed(() => currentFiles.value.some((file) => typeof file.solution === "string"));
const currentFile = computed(() =>
  currentFiles.value.find((file) => file.path === state.activeFilePath) ?? currentFiles.value[0],
);
const walkthrough = computed(() =>
  currentExercise.value.sandbox ? splitWalkthrough(currentExercise.value.sandbox) : null,
);
const walkState = computed(() => {
  walkVersion.value;
  return readWalkState(currentExercise.value);
});
const checkableSteps = computed(() => walkthrough.value?.steps.filter((step) => step.checkable) ?? []);
const completedStepCount = computed(() =>
  checkableSteps.value.filter((step) => walkState.value[step.id]).length,
);
const instructionHtml = computed(() => renderMarkdown(currentExercise.value.readme));
const editorStats = computed(() => {
  const value = editorValue.value;
  const lines = value.length ? value.split("\n").length : 0;
  return `${lines} lines - ${value.length} chars`;
});
const canRunSandbox = computed(() => state.sandboxAvailable);
const canStopSandbox = computed(() => !!state.sandboxId && !state.workerBusy && !state.starterBusy);
const workerStatusLabel = computed(() => {
  if (state.workerBusy && !state.workerActive) return "Worker starting…";
  return state.workerActive ? "Worker running" : "Worker stopped";
});
const generatedAt = computed(() => `Course data ${new Date(course.generatedAt).toLocaleString()}`);

// The deep link to this run's workflow in the sandbox's Temporal Web UI. Mirrors
// the client's "Watch it at …" logic: keep the signed preview URL's host and query
// (the Daytona signature) and just swap in the workflow's path. Falls back to the
// UI root (the workflow list) before a run has reported its id.
const workflowWatchUrl = computed(() => {
  if (!state.temporalUiUrl) return "";
  try {
    const url = new URL(state.temporalUiUrl);
    if (state.workflowId) {
      url.pathname = `/namespaces/default/workflows/${state.workflowId}`;
    }
    return url.toString();
  } catch {
    return "";
  }
});

// Origin of the runner's same-origin Temporal UI proxy. Prefer an explicit base
// (set when the proxy sits behind its own public hostname); otherwise pair the
// reported port with this page's hostname.
const proxyOrigin = computed(() => {
  if (state.uiProxyBase) return state.uiProxyBase.replace(/\/$/, "");
  if (state.uiProxyPort && typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:${state.uiProxyPort}`;
  }
  return "";
});

// The pane keeps ONE iframe alive for the whole sandbox session. It mounts as soon as
// a sandbox exists — off-screen while the pane is still closed — and loads the UI
// root, which warms what matters before the pane ever opens: the browser's bundle
// cache, the proxy's asset cache, the keep-alive connection, and the auth-cookie
// handshake. When the workflow id arrives the src switches to that workflow's page;
// because the bundle is already cached + brotli'd and the connection is warm, that
// load is a "warm reload" rather than a cold one, and later open/close toggles don't
// reload at all (the iframe stays mounted).
const paneSrc = computed(() => {
  if (!proxyOrigin.value || !state.sandboxId) return "";
  const pin = `__s=${encodeURIComponent(state.sandboxId)}`;
  return state.workflowId
    ? `${proxyOrigin.value}/namespaces/default/workflows/${encodeURIComponent(state.workflowId)}?${pin}`
    : `${proxyOrigin.value}/?${pin}`;
});

function onPaneFrameLoad() {
  state.paneFrameLoaded = true;
}

// Records the proxy coordinates the runner reports on /api/health and each run.
function captureProxyConfig(data) {
  if (!data) return;
  if (data.uiProxyBase !== undefined) state.uiProxyBase = data.uiProxyBase || "";
  if (data.uiProxyPort !== undefined) state.uiProxyPort = data.uiProxyPort || 0;
}

// Shortens a module title for the picker: "Module 1 · A durable pipeline (40 min)"
// becomes "A durable pipeline".
function shortTitle(title) {
  return title
    .replace(/^Module\s+\d+\s*[·:.-]\s*/i, "")
    .replace(/\s*\([^)]+\)\s*$/, "")
    .trim();
}

function fileRole(file) {
  if (/(^|\/)worker\.ts$/.test(file.path)) return "worker";
  if (/(^|\/)client\.ts$/.test(file.path)) return "starter";
  return "";
}

function initialExerciseIndex() {
  const fromHash = window.location.hash.replace(/^#/, "");
  const found = course.exercises.findIndex((exercise) => exercise.id === fromHash);
  return found >= 0 ? found : 0;
}

function readWalkState(exercise) {
  try {
    const raw = localStorage.getItem(storageKey("walk", exercise.id));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function setWalkStep(id, checked) {
  const saved = readWalkState(currentExercise.value);
  saved[id] = checked;
  localStorage.setItem(storageKey("walk", currentExercise.value.id), JSON.stringify(saved));
  walkVersion.value += 1;
}

// The editor has two independent views: the exercise (starter) and the solution.
// Each keeps its own edits in localStorage, so toggling between them never
// overwrites the other view's work.
function fileStorageKey(filePath) {
  const prefix = state.fileView === "solution" ? "sol-edit" : "edit";
  return storageKey(prefix, currentExercise.value.id, filePath);
}

// Pristine content for the active view (solution falls back to starter when a
// file has no solution variant).
function baseContent(file) {
  return state.fileView === "solution" && typeof file.solution === "string"
    ? file.solution
    : file.content;
}

function fileContent(file) {
  return localStorage.getItem(fileStorageKey(file.path)) ?? baseContent(file);
}

function isDirty(file) {
  return fileContent(file) !== baseContent(file);
}

function allEditedFiles() {
  return Object.fromEntries(currentFiles.value.map((file) => [file.path, fileContent(file)]));
}

function activateFile(filePath) {
  state.activeFilePath = filePath;
  localStorage.setItem(storageKey("active-file", currentExercise.value.id), filePath);
  syncEditorFromState();
}

function syncEditorFromState() {
  if (!currentFile.value) {
    editorValue.value = "";
    return;
  }
  editorValue.value = fileContent(currentFile.value);
}

function persistCurrentEdit() {
  if (!currentFile.value) return;
  if (editorValue.value === baseContent(currentFile.value)) {
    localStorage.removeItem(fileStorageKey(currentFile.value.path));
  } else {
    localStorage.setItem(fileStorageKey(currentFile.value.path), editorValue.value);
  }
}

function selectExercise(index) {
  state.exerciseIndex = Math.max(0, Math.min(course.exercises.length - 1, index));
  state.fileView = "exercise";
  const exercise = currentExercise.value;
  const savedFile = localStorage.getItem(storageKey("active-file", exercise.id));
  state.activeFilePath = exercise.files.some((file) => file.path === savedFile)
    ? savedFile
    : exercise.files[0]?.path ?? "";
  state.logs = [];
  state.workflowOutput = "";
  state.workerActive = false;
  syncEditorFromState();
  updateHash();
}

function updateHash() {
  const exercise = currentExercise.value;
  if (window.location.hash !== `#${exercise.id}`) {
    history.replaceState(null, "", `#${exercise.id}`);
  }
}

function resetCurrentFile() {
  if (!currentFile.value) return;
  localStorage.removeItem(fileStorageKey(currentFile.value.path));
  syncEditorFromState();
  showToast("File reset");
}

function toggleFileView() {
  state.fileView = state.fileView === "solution" ? "exercise" : "solution";
  syncEditorFromState();
  showToast(state.fileView === "solution" ? "Showing solution" : "Showing exercise");
}

function showToast(message) {
  state.toast = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    state.toast = "";
  }, 1700);
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(`${storagePrefix}:theme`, theme);
}

// Drag-driven splitters. `onMove` maps the pointer position to a size, `persist`
// stores the final value, and we clamp inside each move so the panes stay usable.
function startDrag(event, onMove, persist) {
  event.preventDefault();
  const previousCursor = document.body.style.cursor;
  document.body.style.userSelect = "none";
  document.body.style.cursor = event.currentTarget.dataset.cursor ?? "default";
  // While dragging, a pointer that crosses the workflow iframe would otherwise be
  // captured by it and the drag would stall. This class disables iframe pointer
  // events for the duration so the move events keep reaching the window.
  document.body.classList.add("is-resizing");
  const handleMove = (e) => onMove(e);
  const handleUp = () => {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
    document.body.style.userSelect = "";
    document.body.style.cursor = previousCursor;
    document.body.classList.remove("is-resizing");
    persist();
  };
  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp);
}

function startPaneResize(event) {
  const shell = event.currentTarget.parentElement;
  startDrag(
    event,
    (e) => {
      const styles = getComputedStyle(shell);
      const padLeft = parseFloat(styles.paddingLeft) || 0;
      const padRight = parseFloat(styles.paddingRight) || 0;
      const rect = shell.getBoundingClientRect();
      const inner = rect.width - padLeft - padRight;
      if (inner <= 0) return;
      const ratio = ((e.clientX - rect.left - padLeft) / inner) * 100;
      state.codeWidth = `${Math.min(78, Math.max(28, ratio)).toFixed(2)}%`;
    },
    () => localStorage.setItem(`${storagePrefix}:code-width`, state.codeWidth),
  );
}

function startDockResize(event) {
  const dock = event.currentTarget.nextElementSibling;
  const startY = event.clientY;
  const startHeight = dock.getBoundingClientRect().height;
  startDrag(
    event,
    (e) => {
      const next = startHeight - (e.clientY - startY);
      state.dockHeight = `${Math.round(Math.min(640, Math.max(120, next)))}px`;
    },
    () => localStorage.setItem(`${storagePrefix}:dock-height`, state.dockHeight),
  );
}

// --- Workflow pane ---------------------------------------------------------
function toggleWorkflowPane() {
  state.workflowPaneOpen = !state.workflowPaneOpen;
}

function closeWorkflowPane() {
  state.workflowPaneOpen = false;
}

// Drag the resizer between the instructions and the workflow pane. The pane is the
// last grid column, so its width is the distance from the pointer to the shell's
// right content edge; clamp it so the editor and instructions keep usable room.
function startWorkflowPaneResize(event) {
  const shell = event.currentTarget.parentElement;
  startDrag(
    event,
    (e) => {
      const styles = getComputedStyle(shell);
      const padRight = parseFloat(styles.paddingRight) || 0;
      const rightEdge = shell.getBoundingClientRect().right - padRight;
      const next = rightEdge - e.clientX;
      const max = shell.getBoundingClientRect().width - 560;
      state.paneWidth = `${Math.round(Math.min(Math.max(360, max), Math.max(320, next)))}px`;
    },
    () => localStorage.setItem(`${storagePrefix}:pane-width`, state.paneWidth),
  );
}

// --- CodeMirror editor -----------------------------------------------------
// A CodeMirror 6 instance backs the editor. `editorValue` stays the single source
// of truth: the update listener pushes the learner's edits out, and setEditorDoc()
// pushes programmatic changes (file switch / reset / solution toggle) back in with
// a fresh state, so undo history doesn't bleed across files.
const editorTheme = EditorView.theme(
  {
    "&": { height: "100%", fontSize: "13px", backgroundColor: "#1d1d1f" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      lineHeight: "1.55",
    },
    ".cm-gutters": { backgroundColor: "#1d1d1f", border: "none" },
  },
  { dark: true },
);

// Type checks the current module server-side (no sandbox needed) and caches the
// result so the editor markers and the pre-run gate share one fetch.
async function requestTypecheck() {
  const response = await fetch("/api/typecheck", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      exerciseId: currentExercise.value.id,
      files: allEditedFiles(),
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  state.diagnostics = data.diagnostics ?? [];
  return state.diagnostics;
}

// CodeMirror linter: on a debounce after edits it re-checks the whole module and
// shows the active file's diagnostics as inline squiggles (+ gutter markers via
// lintGutter). A failed check (e.g. runner offline) silently shows nothing so it
// never blocks editing. The server returns offsets within each file, which line
// up with this view's document since it holds that same file's text.
const tsLinter = linter(
  async (view) => {
    if (!currentFile.value) return [];
    let all;
    try {
      all = await requestTypecheck();
    } catch {
      return [];
    }
    const activePath = currentFile.value.path;
    const docLen = view.state.doc.length;
    return all
      .filter((d) => d.file === activePath && typeof d.start === "number")
      .map((d) => ({
        from: Math.min(d.start, docLen),
        to: Math.min(d.start + (d.length ?? 0), docLen),
        severity: d.category === "error" ? "error" : "warning",
        message: d.message,
      }));
  },
  { delay: 600 },
);

function makeEditorState(doc) {
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      keymap.of([indentWithTab]), // Tab indents the selection, Shift+Tab outdents
      javascript({ typescript: true }),
      indentUnit.of("  "),
      EditorState.tabSize.of(2),
      oneDark,
      editorTheme,
      lintGutter(),
      tsLinter,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) editorValue.value = update.state.doc.toString();
      }),
    ],
  });
}

function setEditorDoc(text) {
  if (!editorView || text === editorView.state.doc.toString()) return;
  editorView.setState(makeEditorState(text));
}

async function checkSandbox() {
  state.sandboxStatus = "checking";
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    captureProxyConfig(data);
    state.sandboxAvailable = Boolean(data.daytona);
    state.sandboxStatus = data.daytona ? "ready" : "unavailable";
    state.sandboxMessage = data.daytona
      ? "Live sandbox ready"
      : "Start the sandbox runner to enable live execution.";
  } catch {
    state.sandboxAvailable = false;
    state.sandboxStatus = "unavailable";
    state.sandboxMessage = "Start npm run course:sandbox to enable live runs.";
  }
}

// Marks/unmarks the busy flag(s) for a run kind. "all" drives both tabs.
function setBusy(action, value) {
  if (action !== "starter") state.workerBusy = value;
  if (action !== "worker") state.starterBusy = value;
}

// Shared driver for every run flow (combined / worker / starter). Each kind has
// its own abort controller and busy flag, so worker and starter runs are
// independent: starting/stopping one never cancels or disables the other.
// Returns true when the run completed without error.
async function streamAction(action, extraBody) {
  runControllers[action]?.abort();
  // A new run supersedes any in-flight completion watch from the previous one.
  completionPoll?.abort();
  const controller = new AbortController();
  runControllers[action] = controller;
  setBusy(action, true);
  state.runnerPanel = "console";
  state.spinner = "";
  // Separate worker/starter runs append to the console so both stay visible;
  // only the combined run starts from a clean console.
  if (action === "all") {
    state.logs = [];
    state.workflowOutput = "";
  }

  let ok = false;
  try {
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sandboxId: state.sandboxId || undefined,
        exerciseId: currentExercise.value.id,
        files: allEditedFiles(),
        ...extraBody,
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error((await response.text().catch(() => "")) || `HTTP ${response.status}`);
    }
    await readEventStream(response.body);
    ok = true;
    // Watch for the workflow to complete (now, or after the learner sends a
    // signal / restarts the worker) and celebrate when it does.
    if (state.sandboxId && state.workflowId) {
      startCompletionPoll(state.sandboxId, state.workflowId);
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      state.logs.push(`ERROR: ${err.message}`);
      state.runnerPanel = "console";
    }
  } finally {
    // Only the most recent run of this kind clears its own state; a superseded
    // one bails out so it doesn't disturb the run that replaced it.
    if (runControllers[action] === controller) {
      setBusy(action, false);
      runControllers[action] = null;
    }
  }
  return ok;
}

// Before any sandbox run, block on type errors (warnings are fine). Listing them
// in the console and skipping the launch saves a doomed sandbox round trip. If
// the checker can't be reached we let the run proceed rather than get in the way.
async function passesTypecheckGate() {
  let diagnostics;
  try {
    diagnostics = await requestTypecheck();
  } catch {
    return true;
  }
  const errors = diagnostics.filter((d) => d.category === "error");
  if (errors.length === 0) return true;
  state.runnerPanel = "console";
  state.logs = [
    `Type check found ${errors.length} error${errors.length === 1 ? "" : "s"} — fix these before running:`,
    ...errors.map((d) => `  ${d.file ?? "?"}:${d.line ?? "?"}:${d.col ?? "?"} — ${d.message}`),
  ];
  showToast(`${errors.length} type error${errors.length === 1 ? "" : "s"}`);
  return false;
}

// Combined Run (dock): (re)start the worker and submit a loan application together.
async function runInSandbox() {
  if (!canRunSandbox.value) return;
  if (!(await passesTypecheckGate())) return;
  if (await streamAction("all", {})) state.workerActive = true;
}

// worker.ts tab: start (or restart) the long-running worker. A fresh click
// cancels and restarts the in-flight worker run (once it clears the type gate).
async function runWorker() {
  if (!(await passesTypecheckGate())) return;
  if (await streamAction("worker", { action: "worker" })) state.workerActive = true;
}

// client.ts tab: submit a loan application once against the running worker.
// Re-running cancels and restarts any in-flight starter run.
async function runStarter() {
  if (!(await passesTypecheckGate())) return;
  await streamAction("starter", { action: "starter" });
}

// client.ts tab: cancel an in-flight starter run (no-op if none running).
function stopStarter() {
  runControllers.starter?.abort();
}

// worker.ts tab: stop the long-running worker without tearing down the sandbox.
// No-op (with a hint) when there's no sandbox to act on.
async function stopWorker() {
  if (!state.sandboxId) {
    showToast("No sandbox running");
    return;
  }
  state.workerBusy = true;
  try {
    const response = await fetch("/api/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sandboxId: state.sandboxId, target: "worker" }),
    });
    if (!response.ok) throw new Error(await response.text());
    state.workerActive = false;
    state.logs.push("Worker stopped.");
    showToast("Worker stopped");
  } catch (err) {
    state.logs.push(`Stop worker failed: ${err.message}`);
  } finally {
    state.workerBusy = false;
  }
}

async function readEventStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 2);
      if (!frame.startsWith("data:")) continue;
      handleRunnerEvent(JSON.parse(frame.slice(5).trim()));
    }
  }
}

function handleRunnerEvent({ kind, payload }) {
  if (kind === "log") state.logs.push(payload);
  else if (kind === "spinner") state.spinner = payload || "";
  else if (kind === "ui") {
    state.sandboxId = payload.sandboxId;
    state.temporalUiUrl = payload.uiUrl;
    captureProxyConfig(payload);
    localStorage.setItem(`${storagePrefix}:sandbox-id`, payload.sandboxId);
    localStorage.setItem(`${storagePrefix}:temporal-ui-url`, payload.uiUrl);
  } else if (kind === "result") {
    captureProxyConfig(payload);
    // The workflow id powers the completion watch (see startCompletionPoll) and
    // the Temporal UI deep link. Slide the pane out so the learner watches the
    // run they just started.
    if (payload.workflowId) {
      state.workflowId = payload.workflowId;
      if (state.temporalUiUrl) state.workflowPaneOpen = true;
    }
    // A worker-only run has no workflowResult; leave the output pane untouched.
    if (payload.workflowResult !== undefined) {
      state.workflowOutput = payload.workflowResult || "(no output)";
      state.runnerPanel = "output";
      state.logs.push("Click the Temporal UI button above to inspect (and signal) this workflow in the web UI.");
    }
    currentFiles.value.forEach((file) => {
      if (fileContent(file) === baseContent(file)) return;
      localStorage.setItem(fileStorageKey(file.path), fileContent(file));
    });
  } else if (kind === "error") {
    state.logs.push(`ERROR: ${payload}`);
    state.runnerPanel = "console";
    if (/not found/i.test(String(payload))) clearSandboxState();
  }
}

async function stopSandbox() {
  if (!canStopSandbox.value) return;
  const id = state.sandboxId;
  try {
    const response = await fetch("/api/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sandboxId: id }),
    });
    if (!response.ok) throw new Error(await response.text());
    state.logs.push(`Sandbox ${id} deleted.`);
    clearSandboxState();
    showToast("Sandbox stopped");
  } catch (err) {
    state.logs.push(`Stop failed: ${err.message}`);
  }
}

function clearSandboxState() {
  state.sandboxId = "";
  state.temporalUiUrl = "";
  state.workflowPaneOpen = false;
  state.workerActive = false;
  localStorage.removeItem(`${storagePrefix}:sandbox-id`);
  localStorage.removeItem(`${storagePrefix}:temporal-ui-url`);
}

watch(editorValue, (value) => {
  persistCurrentEdit();
  setEditorDoc(value);
});

// A changed src means a real (re)load (new sandbox, or root → workflow), so re-arm
// the spinner until it paints. Toggling the pane open/closed keeps the same src, so
// it doesn't reload.
watch(paneSrc, () => {
  state.paneFrameLoaded = false;
});

// Keep the freshest console output in view as logs/spinner stream in (and when
// the console tab is reopened), unless the user has scrolled up to read back.
watch(
  () => [state.logs.length, state.spinner, state.runnerPanel],
  () => {
    if (state.runnerPanel !== "console" || !consolePinned) return;
    nextTick(() => {
      const el = consoleRef.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
);

watch(() => state.theme, applyTheme, { immediate: true });

watch(
  () => currentExercise.value.id,
  () => {
    const exercise = currentExercise.value;
    state.fileView = "exercise";
    const savedFile = localStorage.getItem(storageKey("active-file", exercise.id));
    state.activeFilePath = exercise.files.some((file) => file.path === savedFile)
      ? savedFile
      : exercise.files[0]?.path ?? "";
    syncEditorFromState();
  },
  { immediate: true },
);

onMounted(() => {
  editorView = new EditorView({
    state: makeEditorState(editorValue.value),
    parent: editorHostRef.value,
  });
  // Exposed for quick manual testing in the DevTools console: launchConfetti().
  window.launchConfetti = launchConfetti;
  checkSandbox();
  updateHash();
  window.addEventListener("hashchange", () => {
    const id = window.location.hash.replace(/^#/, "");
    const index = course.exercises.findIndex((exercise) => exercise.id === id);
    if (index >= 0 && index !== state.exerciseIndex) selectExercise(index);
  });
  // First-time visitors get the tour automatically once the layout has settled.
  if (!localStorage.getItem(tourSeenKey)) {
    window.setTimeout(startTour, 600);
  }
});

onBeforeUnmount(() => {
  editorView?.destroy();
  Object.values(runControllers).forEach((controller) => controller?.abort());
  window.clearTimeout(toastTimer);
});
</script>

<template>
  <div class="app-frame">
    <header class="topbar">
      <div class="brand">
        <img class="brand-image" src="/assets/course-visual.png" alt="Temporal">
        <div class="brand-copy">
          <p class="eyebrow">Temporal Workshop</p>
          <h2>Agentic Loan Origination</h2>
        </div>
      </div>
      <div class="topbar-controls">
        <button class="button button-secondary" type="button" :disabled="state.exerciseIndex === 0" @click="selectExercise(state.exerciseIndex - 1)">
          Previous
        </button>
        <label class="exercise-picker" data-tour="exercise-picker">
          <select :value="state.exerciseIndex" @change="selectExercise(Number($event.target.value))">
            <option v-for="(exercise, index) in course.exercises" :key="exercise.id" :value="index">
              Module {{ exercise.number }}: {{ shortTitle(exercise.title) }}
            </option>
          </select>
        </label>
        <button class="button button-secondary" type="button" :disabled="state.exerciseIndex === course.exercises.length - 1" @click="selectExercise(state.exerciseIndex + 1)">
          Next
        </button>
        <button class="button button-secondary" type="button" title="Take the product tour" @click="startTour">
          Tour
        </button>
        <button class="button button-secondary theme-toggle" type="button" :aria-pressed="state.theme === 'dark'" :title="themeToggleLabel" @click="toggleTheme">
          {{ state.theme === "dark" ? "☀" : "☾" }}
        </button>
      </div>
    </header>

    <main
      class="course-shell"
      :class="{ 'pane-open': state.workflowPaneOpen }"
      :style="{ '--code-col': state.codeWidth || undefined, '--pane-width': state.paneWidth || undefined }"
    >
      <section class="workspace-panel code-panel" aria-label="Code workspace">
        <div class="file-tabs" role="tablist" aria-label="Source files" data-tour="file-tabs">
          <template v-for="file in currentFiles" :key="file.path">
            <button
              class="file-tab"
              :class="{ active: file.path === state.activeFilePath, dirty: isDirty(file) }"
              type="button"
              role="tab"
              :title="file.path"
              @click="activateFile(file.path)"
            >
              {{ labelForPath(currentExercise, file.path) }}
            </button>
            <span v-if="fileRole(file) === 'worker'" class="tab-run">
              <button class="tab-btn" type="button" title="Start the worker" @click="runWorker">▶</button>
              <button class="tab-btn" type="button" title="Stop the worker" @click="stopWorker">■</button>
            </span>
            <span v-else-if="fileRole(file) === 'starter'" class="tab-run">
              <button class="tab-btn" type="button" title="Submit a loan application" @click="runStarter">▶</button>
              <button class="tab-btn" type="button" title="Cancel the run" @click="stopStarter">■</button>
            </span>
          </template>
          <button
            v-if="hasSolution"
            class="view-tab"
            data-tour="solution-toggle"
            :class="{ active: state.fileView === 'solution' }"
            type="button"
            :title="viewToggleLabel"
            @click="toggleFileView"
          >
            {{ viewToggleLabel }}
          </button>
        </div>

        <div class="editor-shell" data-tour="editor">
          <div ref="editorHostRef" class="code-mirror-host"></div>
        </div>
        <div class="dock-resizer" data-cursor="row-resize" role="separator" aria-orientation="horizontal" aria-label="Resize runner panel" @pointerdown="startDockResize" />
        <div class="runner-dock" :style="{ height: state.dockHeight || undefined }">
          <div class="runner-tabs" role="tablist" aria-label="Runner output">
            <button class="runner-tab" :class="{ active: state.runnerPanel === 'console' }" type="button" @click="state.runnerPanel = 'console'">Console</button>
            <button class="runner-tab" :class="{ active: state.runnerPanel === 'output' }" type="button" @click="state.runnerPanel = 'output'">Output</button>
            <span class="worker-status" :class="{ active: state.workerActive, busy: state.workerBusy }">
              <span class="worker-dot" aria-hidden="true"></span>
              {{ workerStatusLabel }}
            </span>
            <div class="runner-actions" data-tour="runner-actions">
              <button class="button button-primary" type="button" data-tour="run" :disabled="!canRunSandbox" @click="runInSandbox">
                Run
              </button>
              <button v-if="state.sandboxId && state.temporalUiUrl" class="button button-link button-cta" type="button" :aria-pressed="state.workflowPaneOpen" @click="toggleWorkflowPane">Temporal UI</button>
              <button class="button" type="button" @click="resetCurrentFile">Reset</button>
              <button class="button" type="button" :disabled="!canStopSandbox" @click="stopSandbox">Stop</button>
            </div>
          </div>
          <pre ref="consoleRef" v-show="state.runnerPanel === 'console'" class="runner-output" @scroll="onConsoleScroll">{{ state.logs.length ? state.logs.join('\n') : 'Runner logs appear here once you launch.' }}<template v-if="state.spinner">{{ `\n${state.spinner}` }}</template></pre>
          <pre v-show="state.runnerPanel === 'output'" class="runner-output">{{ state.workflowOutput || 'Workflow output appears here after a successful run.' }}</pre>
        </div>
        <div class="editor-footer">
          <span>{{ editorStats }}</span>
          <span>{{ generatedAt }}</span>
        </div>
      </section>

      <div class="pane-resizer" data-cursor="col-resize" role="separator" aria-orientation="vertical" aria-label="Resize panels" @pointerdown="startPaneResize" />

      <section class="workspace-panel instruction-panel" aria-label="Module instructions" data-tour="instructions">
        <div class="instruction-heading">
          <div class="instruction-heading-top">
            <p class="panel-kicker">Instructions</p>
            <span v-if="checkableSteps.length" class="step-progress-count">
              {{ completedStepCount }}/{{ checkableSteps.length }}
            </span>
          </div>
          <div
            v-if="checkableSteps.length"
            class="step-progress"
            role="progressbar"
            :aria-valuenow="completedStepCount"
            :aria-valuemax="checkableSteps.length"
            :aria-label="`${completedStepCount} of ${checkableSteps.length} steps complete`"
          >
            <span
              v-for="step in checkableSteps"
              :key="step.id"
              class="step-progress-seg"
              :class="{ filled: walkState[step.id] }"
            />
          </div>
        </div>

        <div class="instruction-content">
          <div v-if="walkthrough" class="walkthrough">
            <div v-html="walkthrough.intro" />
            <template v-for="step in walkthrough.steps" :key="`${currentExercise.id}-${step.id}`">
              <div v-if="step.checkable" class="step-block" :class="{ completed: walkState[step.id] }">
                <div class="step-body" v-html="step.html" />
                <label class="step-check" :class="{ done: walkState[step.id] }">
                  <input
                    type="checkbox"
                    :checked="walkState[step.id]"
                    @change="setWalkStep(step.id, $event.target.checked)"
                  >
                  <span>{{ walkState[step.id] ? "Step complete" : "Mark step complete" }}</span>
                </label>
              </div>
              <div v-else class="step-plain" v-html="step.html" />
            </template>
          </div>
          <div v-else v-html="instructionHtml" />
        </div>
      </section>

      <div
        v-if="state.workflowPaneOpen"
        class="pane-resizer"
        data-cursor="col-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workflow pane"
        @pointerdown="startWorkflowPaneResize"
      />
      <!-- One persistent iframe per sandbox: mounted as soon as the sandbox exists so
           the SPA boots off-screen, kept alive across open/close (and client-navigated
           rather than reloaded) so it never re-downloads or re-parses the bundle. -->
      <section
        v-if="proxyOrigin && state.sandboxId"
        class="workspace-panel workflow-pane"
        :class="{ 'workflow-pane--collapsed': !state.workflowPaneOpen }"
        :aria-hidden="!state.workflowPaneOpen"
        aria-label="Workflow in Temporal UI"
      >
        <header class="workflow-pane-head">
          <div class="workflow-pane-title">
            <span class="panel-kicker">Temporal UI</span>
            <code v-if="state.workflowId" class="workflow-pane-id">{{ state.workflowId }}</code>
          </div>
          <div class="workflow-pane-actions">
            <a v-if="workflowWatchUrl" class="button button-link" :href="workflowWatchUrl" target="_blank" rel="noopener" title="Open in a new tab">Open ↗</a>
            <button class="button" type="button" title="Close" @click="closeWorkflowPane">✕</button>
          </div>
        </header>
        <div class="workflow-pane-body">
          <iframe
            v-if="paneSrc"
            :src="paneSrc"
            class="workflow-pane-frame"
            title="Temporal Web UI"
            @load="onPaneFrameLoad"
          />
          <div v-if="paneSrc && state.workflowPaneOpen && !state.paneFrameLoaded" class="workflow-pane-loading" role="status" aria-live="polite">
            <span class="workflow-pane-spinner" aria-hidden="true"></span>
            <span>Loading the workflow…</span>
          </div>
        </div>
      </section>
    </main>
  </div>

  <div class="toast" :class="{ visible: state.toast }" role="status" aria-live="polite">{{ state.toast }}</div>

  <Tour v-if="tourVisible" :steps="tourSteps" @finish="finishTour" />
</template>
