import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import zlib from "node:zlib";

import crypto from "node:crypto";

import { Daytona, Image } from "@daytonaio/sdk";
import ts from "typescript";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePackagePath = path.join(rootDir, "course", "runtime", "typescript", "package.json");
const tsconfigPath = path.join(rootDir, "tsconfig.json");

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
// In production (Fly.io) a single process serves both the built course site and
// the /api/* endpoints from the same origin, so the SPA's relative /api calls
// keep working. In local dev Vite serves the site and proxies /api here, so this
// stays unset and the runner only answers the API.
const distDir = process.env.COURSE_DIST_DIR
  ? path.resolve(process.env.COURSE_DIST_DIR)
  : null;
const appDir = "/opt/app";
const temporalBin = "/usr/local/bin/temporal";
const temporalUiPort = 8233;

// The browser embeds each sandbox's Temporal Web UI in a slide-out pane. The
// sandbox's signed daytonaproxy URL can't be iframed directly (it answers with
// X-Frame-Options: SAMEORIGIN, and its auth cookies are scoped to that domain so
// they're blocked as third-party in a cross-site frame). So we run a small
// same-origin reverse proxy that forwards to the sandbox UI, strips the framing
// headers, and re-scopes cookies to the proxy's own host. It listens on its own
// port (default PORT+1); set UI_PROXY_PORT to override. When the proxy is exposed
// behind a public hostname that differs from the page's host:port, set
// UI_PROXY_PUBLIC_BASE (e.g. https://tui.example.com) so the browser targets it
// directly; otherwise the page derives it from its own hostname + this port.
const uiProxyPort = Number(process.env.UI_PROXY_PORT ?? port + 1);
const uiProxyPublicBase = process.env.UI_PROXY_PUBLIC_BASE?.replace(/\/$/, "") || null;
// Pins a browser to its sandbox so the Temporal UI's root-absolute asset/API
// requests (which carry no sandbox hint) reach the right upstream.
const uiProxyCookie = "tui_sandbox";

// The Module 4 agent calls OpenAI through a shared LiteLLM proxy on Fly that
// holds the real OpenAI key. We inject the proxy's URL + shared key into each
// Module 4 sandbox, so the agent reaches OpenAI while the real OpenAI key never
// lands in student-editable code. The proxy enforces a global rate limit and the
// OpenAI project carries a hard spend cap. See litellm/README.md.
const llmProxyUrl = process.env.LLM_PROXY_URL?.replace(/\/$/, "");
const llmProxyKey = process.env.LLM_PROXY_KEY;
// Model name the agent requests; the proxy maps "agent-model" to a real model.
const agentModel = process.env.AGENT_MODEL ?? "agent-model";
// How long the starter may wait. Our client.ts starts the loan workflow and
// exits (it does not block on the workflow, which pauses for human signals you
// send from the Temporal UI), so this is a generous safety net only.
const starterTimeoutMs = 10 * 60_000;

// Module 3 demonstrates the recoverable pattern, which only triggers on bad
// input — so its client runs the failing scenario by default.
const starterScenarios = {
  "module-3-recoverable": "bad-ssn",
};

// Every module runs the same lightweight image: Node + the Temporal CLI. procps
// gives us pkill, which the runner uses to (re)start the worker. (Module 4's
// agent reaches its model over HTTP — there's no model running in the sandbox.)
const temporalCliInstall = [
  "apt-get update",
  "apt-get install -y --no-install-recommends curl ca-certificates procps",
  'arch=$(uname -m | sed "s/x86_64/amd64/;s/aarch64/arm64/")',
  'curl -fsSL "https://temporal.download/cli/archive/latest?platform=linux&arch=$arch" -o /tmp/t.tgz',
  `tar -xzf /tmp/t.tgz -C ${path.dirname(temporalBin)} temporal`,
  `chmod +x ${temporalBin}`,
  "rm /tmp/t.tgz",
  "rm -rf /var/lib/apt/lists/*",
].join(" && ");

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeSse(res, kind, payload) {
  res.write(`data: ${JSON.stringify({ kind, payload })}\n\n`);
}

// Races a promise against a timeout. The Daytona SDK gives its HTTP client a 24h
// axios timeout with no retry, so a slow or stalled control-plane call would
// otherwise hang a run indefinitely. We can't abort the underlying request, but
// we stop waiting on it and let the caller recover (e.g. create a fresh sandbox).
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Debug logging for sandbox interactions. These go to the runner's own stdout
// (the application log) - NOT the SSE `events.log` channel shown in the browser
// console - so we can study per-interaction latency without cluttering the UI.
// Enabled by default; set SANDBOX_DEBUG=false to silence.
const sandboxDebug = process.env.SANDBOX_DEBUG !== "false";
function debugLog(message) {
  if (!sandboxDebug) return;
  console.log(`${new Date().toISOString()} [sandbox] ${message}`);
}

// Times an async sandbox interaction and logs its duration (and failures) to the
// application log. Returns the wrapped promise's result untouched.
async function timed(label, fn) {
  if (!sandboxDebug) return fn();
  const start = Date.now();
  try {
    const result = await fn();
    debugLog(`${label} ok ${Date.now() - start}ms`);
    return result;
  } catch (err) {
    debugLog(`${label} FAILED ${Date.now() - start}ms: ${err.message}`);
    throw err;
  }
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

// Serves the built SPA from distDir. Unknown paths fall back to index.html so
// client-side routing works; hashed assets get long-lived caching, the entry
// HTML stays uncached so deploys are picked up.
async function serveStatic(req, res, urlPath) {
  const rel = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(distDir, rel);
  if (!filePath.startsWith(distDir)) filePath = path.join(distDir, "index.html");

  let body;
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) throw new Error("is a directory");
    body = await fs.readFile(filePath);
  } catch {
    filePath = path.join(distDir, "index.html");
    body = await fs.readFile(filePath);
  }

  const ext = path.extname(filePath).toLowerCase();
  const isAsset = filePath.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    "Content-Type": contentTypes[ext] ?? "application/octet-stream",
    "Cache-Control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function sourceFilePaths(moduleId) {
  const dir = path.join(rootDir, moduleId, "starter", "src");
  const out = [];
  async function walk(current, base = dir) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(abs, base);
      else if (/\.(ts|tsx|js|json)$/.test(entry.name)) {
        out.push(path.relative(base, abs).split(path.sep).join("/"));
      }
    }
  }
  await walk(dir);
  return out.sort();
}

// --- Server-side type checking ---------------------------------------------
// Type checking needs only the source plus type declarations - not a running
// sandbox - so we run it in-process with the TypeScript compiler API against the
// repo's own node_modules. That gives the editor near-instant diagnostics
// without paying any of the Daytona round trips that a real run does.

// The project's tsconfig, parsed once. skipLibCheck/noEmit keep checks cheap.
let cachedCompilerOptions;
function compilerOptions() {
  if (cachedCompilerOptions) return cachedCompilerOptions;
  const { config, error } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (error) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, rootDir);
  cachedCompilerOptions = { ...parsed.options, noEmit: true, skipLibCheck: true };
  return cachedCompilerOptions;
}

// Shared across modules so unchanged files (lib.d.ts, node_modules typings) are
// parsed once and reused between checks.
const documentRegistry = ts.createDocumentRegistry();
// moduleId -> { service, snapshots, srcBase }
const typeCheckers = new Map();

// A LanguageService per module, fed from an in-memory `snapshots` map of the
// module's source files. Reusing the service (and the document registry) across
// calls makes repeated checks incremental and fast.
function getTypeChecker(moduleId, srcBase) {
  const existing = typeCheckers.get(moduleId);
  if (existing) return existing;
  const snapshots = new Map(); // absPath -> { text, version }
  const host = {
    getScriptFileNames: () => [...snapshots.keys()],
    getScriptVersion: (file) => String(snapshots.get(file)?.version ?? 0),
    getScriptSnapshot: (file) => {
      const snap = snapshots.get(file);
      if (snap) return ts.ScriptSnapshot.fromString(snap.text);
      const text = ts.sys.readFile(file);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => rootDir,
    getCompilationSettings: () => compilerOptions(),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  };
  const checker = { service: ts.createLanguageService(host, documentRegistry), snapshots, srcBase };
  typeCheckers.set(moduleId, checker);
  return checker;
}

// Type-checks a module with the learner's edits overlaid, returning diagnostics
// shaped for the editor: file is the tab key ("src/foo.ts"), start/length are
// offsets within that file (so the editor can place inline markers directly).
async function typecheckModule({ exerciseId, files }) {
  if (!/^module-\d+/.test(exerciseId ?? "")) {
    throw new Error("exerciseId must be a module directory such as module-1-durable-pipeline");
  }
  const srcBase = path.join(rootDir, exerciseId, "starter", "src");
  const relFiles = await sourceFilePaths(exerciseId);
  const { service, snapshots } = getTypeChecker(exerciseId, srcBase);

  // Update the overlay: edited content from the payload, else pristine on disk.
  // Bump a file's version only when its text actually changes so the document
  // registry can reuse unchanged ASTs.
  const liveFiles = new Set();
  await Promise.all(
    relFiles
      .filter((rel) => /\.tsx?$/.test(rel)) // only TS files participate in the check
      .map(async (rel) => {
        const abs = path.join(srcBase, rel);
        liveFiles.add(abs);
        const incoming = files?.[`src/${rel}`] ?? files?.[rel];
        const text =
          incoming === undefined
            ? await fs.readFile(abs, "utf8")
            : String(incoming).replace(/\r\n/g, "\n");
        const prev = snapshots.get(abs);
        if (!prev || prev.text !== text) {
          snapshots.set(abs, { text, version: (prev?.version ?? 0) + 1 });
        }
      }),
  );
  // Drop files that no longer exist in the module so stale snapshots don't linger.
  for (const abs of [...snapshots.keys()]) {
    if (!liveFiles.has(abs)) snapshots.delete(abs);
  }

  const diagnostics = [];
  for (const abs of liveFiles) {
    const raw = [...service.getSyntacticDiagnostics(abs), ...service.getSemanticDiagnostics(abs)];
    for (const d of raw) {
      const sf = d.file;
      const file = sf
        ? `src/${path.relative(srcBase, sf.fileName).split(path.sep).join("/")}`
        : null;
      let line = null;
      let col = null;
      if (sf && typeof d.start === "number") {
        const lc = sf.getLineAndCharacterOfPosition(d.start);
        line = lc.line + 1;
        col = lc.character + 1;
      }
      diagnostics.push({
        file,
        start: d.start ?? null,
        length: d.length ?? null,
        line,
        col,
        code: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        category: d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
      });
    }
  }
  return diagnostics;
}

// Reads the workflow id the client.ts will use for the given scenario straight
// from its `scenarios` map, so the completion watch (and thus the confetti)
// always polls the right id. Deriving it here — rather than duplicating the id
// in this file — keeps it from drifting when the per-module ids change.
async function resolveWorkflowId(moduleDir, scenario) {
  const clientPath = path.join(moduleDir, "starter", "src", "client.ts");
  const source = await fs.readFile(clientPath, "utf8");
  // Match `<key>:` (e.g. `clean:` or `'bad-ssn':`) then the next applicationId.
  const key = scenario || "clean";
  const block = new RegExp(`['"]?${key}['"]?\\s*:\\s*\\{[^}]*?applicationId\\s*:\\s*['"]([^'"]+)['"]`);
  const match = source.match(block);
  if (!match) {
    throw new Error(`Could not find applicationId for scenario "${key}" in ${clientPath}`);
  }
  return match[1];
}

async function resolveModule(moduleId) {
  if (!/^module-\d+/.test(moduleId ?? "")) {
    throw new Error("moduleId must be a module directory such as module-1-durable-pipeline");
  }
  const moduleDir = path.join(rootDir, moduleId);
  await fs.access(path.join(moduleDir, "starter", "src"));
  const files = await sourceFilePaths(moduleId);
  const scenario = starterScenarios[moduleId] ?? "";
  // tsx (esbuild-based) starts several times faster than ts-node: it skips type
  // checking and uses a lighter loader, so each worker/client cold start - the
  // dominant cost of a run - is much cheaper. Students don't need compile errors
  // surfaced at runtime (the editor's type check covers that).
  const tsx = "npx tsx";
  const starterCmd = `${tsx} ${moduleId}/starter/src/client.ts${scenario ? ` ${scenario}` : ""}`;
  return {
    id: moduleId,
    // Base dir used when reading pristine source files from disk.
    dir: path.join(moduleDir, "starter"),
    files,
    worker: `${tsx} ${moduleId}/starter/src/worker.ts`,
    starter: starterCmd,
    workerProcessPattern: `${moduleId}/starter/src/worker.ts`,
    // The workflow id the client uses, read from client.ts. The browser polls
    // /api/await-result with this to celebrate completion.
    workflowId: await resolveWorkflowId(moduleDir, scenario),
    // Module 4's agent needs a local LLM; detected by its agent activities file.
    needsLlm: files.includes("agent-activities.ts"),
  };
}

function runtimeImage() {
  // One image for all modules: Node + Temporal CLI + the runtime deps.
  return Image.base("node:20-bookworm-slim")
    .runCommands(temporalCliInstall)
    .workdir(appDir)
    .addLocalFile(runtimePackagePath, `${appDir}/package.json`)
    .runCommands(`cd ${appDir} && npm install --silent`);
}

class CourseSandboxManager {
  constructor() {
    if (!process.env.DAYTONA_KEY) {
      throw new Error("DAYTONA_KEY environment variable is required");
    }
    this.daytona = new Daytona({ apiKey: process.env.DAYTONA_KEY });
    // sandbox.id -> { url, expiresAt }. The signed Temporal UI preview URL is
    // valid for an hour but we fetched it on every run; cache it so re-runs skip
    // that round trip.
    this.previewUrls = new Map();
    // sandbox.id -> { running, hash, cmdId }. Lets a combined "Run" skip the
    // worker restart (~3s of bundle + boot) when a worker is already running and
    // the worker-relevant files are unchanged - the common "edit client, submit
    // again" loop.
    this.workerState = new Map();
  }

  // Hashes the worker-relevant source (everything but client.ts) with the
  // learner's edits overlaid. A combined run reuses the running worker when this
  // is unchanged; any edit to workflow/activity/worker code changes it and forces
  // a restart.
  async workerFilesHash(module, files) {
    const relevant = module.files
      .filter((file) => !/(^|\/)client\.ts$/.test(file))
      .sort();
    const hash = crypto.createHash("sha1");
    for (const file of relevant) {
      const incoming = files?.[`src/${file}`] ?? files?.[file];
      const content =
        incoming === undefined
          ? await fs.readFile(path.join(module.dir, "src", file), "utf8")
          : String(incoming).replace(/\r\n/g, "\n");
      hash.update(`${file}\0${content}\0`);
    }
    return hash.digest("hex");
  }

  // True only when a worker we started is still actually running (the process
  // didn't crash and the session is still queryable). A cheap getSessionCommand
  // beats wrongly skipping a restart and then hanging the client until timeout.
  async workerStillAlive(sandbox, state) {
    if (!state?.running || state.cmdId === undefined) return false;
    const cmd = await timed("worker: liveness check", () =>
      sandbox.process.getSessionCommand("worker", state.cmdId),
    ).catch(() => null);
    return Boolean(cmd) && (cmd.exitCode === null || cmd.exitCode === undefined);
  }

  // Returns the sandbox's signed Temporal UI URL, reusing a cached one until it
  // nears the 3600s signature expiry.
  async getPreviewUrl(sandbox) {
    const cached = this.previewUrls.get(sandbox.id);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    const preview = await timed(`getSignedPreviewUrl ${sandbox.id}`, () =>
      sandbox.getSignedPreviewUrl(temporalUiPort, 3600),
    );
    // Refetch a little before the signature actually lapses.
    this.previewUrls.set(sandbox.id, { url: preview.url, expiresAt: Date.now() + 3000 * 1000 });
    return preview.url;
  }

  // Resolves the Temporal UI base URL for a sandbox id, used by the UI proxy.
  // Serves the cached signed URL when fresh; otherwise re-resolves the sandbox
  // (which a long-lived proxy connection may outlive) and fetches a new one.
  async previewBaseFor(sandboxId) {
    const cached = this.previewUrls.get(sandboxId);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    const sandbox = await this.daytona.get(sandboxId);
    return this.getPreviewUrl(sandbox);
  }

  // Dispatches a run request. `action` selects which parts run:
  //   "worker"  - (re)start the long-running worker, creating the sandbox if needed
  //   "starter" - run the client once against an already-running worker
  //   "all"     - the combined flow: (re)start the worker, then run the client
  async run({ action = "all", sandboxId, exerciseId, files }, events, onUiReady) {
    const runStart = Date.now();
    debugLog(`run start action=${action} exercise=${exerciseId} sandbox=${sandboxId ?? "new"}`);
    const module = await resolveModule(exerciseId);
    const wantStarter = action === "all" || action === "starter";

    let sandbox = sandboxId ? await this.resolveRunningSandbox(sandboxId, events) : null;
    let uiInfo = {};
    let created = false;
    if (sandbox) {
      events.log("Uploading files...");
      await this.uploadModule(sandbox, module, files);
    } else {
      // No usable sandbox (never created, or the previous one expired) - make a
      // fresh one. createSandbox brings up Temporal (and, for Module 4, injects
      // the LLM proxy env) and emits the new UI info.
      ({ sandbox, uiInfo } = await this.createSandbox(module, files, events, onUiReady));
      created = true;
    }

    // Decide whether to (re)start the worker:
    //   - explicit "worker" run: always restart.
    //   - fresh sandbox: must start one (none exists yet), even for starter-only.
    //   - combined "all" on an existing sandbox: skip the restart when a worker
    //     is already running with unchanged worker-relevant files.
    //   - starter-only on an existing sandbox: never start (run against the
    //     running worker).
    const workerHash = await this.workerFilesHash(module, files);
    let mustStartWorker;
    if (action === "worker") {
      mustStartWorker = true;
    } else if (created) {
      mustStartWorker = true;
    } else if (action === "all") {
      const prev = this.workerState.get(sandbox.id);
      const reusable =
        prev?.hash === workerHash && (await this.workerStillAlive(sandbox, prev));
      mustStartWorker = !reusable;
      if (reusable) events.log("Worker code unchanged — reusing the running worker.");
    } else {
      mustStartWorker = false;
    }

    try {
      if (mustStartWorker) {
        // About to restart; drop any stale state so a failed start doesn't leave
        // a "running" marker behind.
        this.workerState.delete(sandbox.id);
        const cmdId = await this.startWorker(sandbox, module, events);
        this.workerState.set(sandbox.id, { running: true, hash: workerHash, cmdId });
      }
      const out = {};
      if (wantStarter) out.workflowResult = await this.runStarter(sandbox, module, events);
      // We hand back the workflow id; the browser then polls /api/await-result and
      // celebrates when the workflow actually completes — which for modules that
      // pause for a human signal happens after the learner sends it, and after a
      // worker restart in the durability demo. One uniform "you did it" moment.
      debugLog(`run done action=${action} sandbox=${sandbox.id} total=${Date.now() - runStart}ms`);
      return { ...uiInfo, sandboxId: sandbox.id, workflowId: module.workflowId, ...out };
    } catch (err) {
      if (created) {
        events.log(`Launch failed: ${err.message}. Cleaning up sandbox...`);
        try {
          await sandbox.delete();
        } catch (cleanupErr) {
          events.log(`Cleanup error ignored: ${cleanupErr.message}`);
        }
        this.workerState.delete(sandbox.id);
        this.previewUrls.delete(sandbox.id);
      }
      throw err;
    }
  }

  // Returns the existing sandbox only if it's still usable. Sandboxes auto-stop
  // after a period of inactivity and are auto-deleted soon after, so a stored id
  // may point at something that's been deleted (get throws) or merely stopped
  // (state !== "started"). In either "expired" case we discard it - and delete a
  // stale stopped one - so the caller creates a fresh sandbox instead.
  async resolveRunningSandbox(sandboxId, events) {
    events.log("Resolving sandbox...");
    let sandbox;
    try {
      // get() already returns the sandbox's current state, so there's no need to
      // follow it with refreshData() (an identical GET /sandbox/{id}). Bound it
      // so a stalled control-plane call falls through to a fresh sandbox instead
      // of hanging on the SDK's 24h timeout.
      sandbox = await withTimeout(
        timed(`daytona.get ${sandboxId}`, () => this.daytona.get(sandboxId)),
        10_000,
        "Resolving sandbox",
      );
    } catch (err) {
      events.log(`Sandbox ${sandboxId} is unavailable (${err.message}). Starting a new one...`);
      this.previewUrls.delete(sandboxId);
      this.workerState.delete(sandboxId);
      return null;
    }
    if (sandbox.state && sandbox.state !== "started") {
      events.log(`Sandbox ${sandboxId} is ${sandbox.state}. Starting a new one...`);
      try {
        await sandbox.delete();
      } catch {
        /* it will be auto-deleted anyway */
      }
      this.previewUrls.delete(sandboxId);
      this.workerState.delete(sandboxId);
      return null;
    }
    return sandbox;
  }

  async createSandbox(module, files, events, onUiReady) {
    events.log(`Creating sandbox for ${module.id}...`);

    // Module 4's agent calls OpenAI through the shared proxy. Inject the proxy
    // URL + shared key + model name as env vars the agent reads. The real OpenAI
    // key stays in the proxy.
    const envVars = {};
    if (module.needsLlm) {
      if (!llmProxyUrl || !llmProxyKey) {
        throw new Error(
          "Module 4 needs the LLM proxy: set LLM_PROXY_URL and LLM_PROXY_KEY (see litellm/README.md).",
        );
      }
      // Provider-neutral names: the agent points at the proxy (an OpenAI-compatible
      // endpoint), but this isn't an OpenAI key — it's the proxy's shared key.
      envVars.LLM_BASE_URL = `${llmProxyUrl}/v1`;
      envVars.LLM_API_KEY = llmProxyKey;
      envVars.AGENT_MODEL = agentModel;
    }

    const sandbox = await timed(`daytona.create ${module.id}`, () =>
      this.daytona.create(
        {
          image: runtimeImage(),
          language: "typescript",
          envVars,
          autoStopInterval: 15,
          autoDeleteInterval: 30,
          // cpu pinned to 2 (Daytona's default is 1) for snappier ts-node cold
          // starts and the Temporal server + worker running side by side.
          resources: { disk: 1, memory: 2, cpu: 2 },
        },
        { timeout: 120 },
      ),
    );

    try {
      events.log(`Sandbox created: ${sandbox.id}`);
      // Launch Temporal and upload the module concurrently so the server boots
      // while files transfer, then block on Temporal health. The upload consumes
      // part of the boot, so the remaining health wait is shorter.
      const [temporalCmdId] = await Promise.all([
        this.launchTemporal(sandbox, events),
        this.uploadModule(sandbox, module, files),
      ]);
      await timed("temporal: wait healthy", () =>
        this.waitForTemporal(sandbox, "temporal-server", temporalCmdId, events),
      );
      const uiUrl = await this.getPreviewUrl(sandbox);
      const uiInfo = { sandboxId: sandbox.id, uiUrl };
      events.log(`Temporal UI: ${uiUrl}`);
      onUiReady(uiInfo);
      return { sandbox, uiInfo };
    } catch (err) {
      events.log(`Launch failed: ${err.message}. Cleaning up sandbox...`);
      try {
        await sandbox.delete();
      } catch (cleanupErr) {
        events.log(`Cleanup error ignored: ${cleanupErr.message}`);
      }
      throw err;
    }
  }

  async stop(sandboxId) {
    const sandbox = await this.daytona.get(sandboxId);
    await sandbox.delete();
    this.previewUrls.delete(sandboxId);
    this.workerState.delete(sandboxId);
  }

  async stopWorker(sandboxId) {
    const sandbox = await this.daytona.get(sandboxId);
    await sandbox.process.executeCommand(`pkill -f "starter/src/worker.ts" 2>/dev/null; true`);
    // The worker is gone now; a later combined run must restart it, not reuse it.
    this.workerState.delete(sandboxId);
    try {
      await sandbox.process.deleteSession("worker");
    } catch {
      /* no worker session */
    }
  }

  async uploadModule(sandbox, module, files) {
    // Build every payload, then push them all in ONE bulk-upload request.
    // uploadFile() is itself a one-item uploadFiles() (a POST to
    // /files/bulk-upload), which mkdir -p's each destination's parents - so no
    // separate createFolder step is needed (verified: a nested upload under the
    // image's writable /opt/app workdir creates the intervening dirs itself).
    const payloads = await Promise.all(
      module.files.map(async (file) => {
        // The browser posts edited files keyed by their tab path ("src/foo.ts");
        // fall back to the pristine source on disk when a file wasn't edited.
        const incoming = files?.[`src/${file}`] ?? files?.[file];
        const content =
          incoming === undefined
            ? await fs.readFile(path.join(module.dir, "src", file), "utf8")
            : String(incoming).replace(/\r\n/g, "\n");
        return {
          source: Buffer.from(content),
          destination: `${appDir}/${module.id}/starter/src/${file}`,
        };
      }),
    );
    payloads.push({ source: await fs.readFile(tsconfigPath), destination: `${appDir}/tsconfig.json` });
    await timed(`uploadFiles ${module.id} (${payloads.length})`, () => sandbox.fs.uploadFiles(payloads));
  }

  // Launches the Temporal dev server (async) and returns its command id. Split
  // from the health wait so callers can overlap the server's boot with other
  // setup (e.g. uploading the module) before blocking on readiness.
  async launchTemporal(sandbox, events) {
    events.log("Starting Temporal dev server...");
    const { cmdId } = await timed("temporal: launch", async () => {
      await sandbox.process.createSession("temporal-server");
      return sandbox.process.executeSessionCommand("temporal-server", {
        command: `${temporalBin} server start-dev --ip 0.0.0.0 --ui-ip 0.0.0.0 --log-level warn`,
        runAsync: true,
      });
    });
    return cmdId;
  }

  // (Re)starts the long-running worker. Killing any existing worker first makes
  // this safe to call whether or not one is already running.
  async startWorker(sandbox, module, events) {
    events.log("Stopping previous worker...");
    await timed("worker: stop previous", async () => {
      await sandbox.process.executeCommand(`pkill -f "${module.workerProcessPattern}" 2>/dev/null; true`);
      try {
        await sandbox.process.deleteSession("worker");
      } catch {
        /* no worker session */
      }
    });

    events.log("Starting worker...");
    events.log(`$ ${module.worker}`);
    const { cmdId } = await timed("worker: start command", async () => {
      await sandbox.process.createSession("worker");
      return sandbox.process.executeSessionCommand("worker", {
        command: `cd ${appDir} && ${module.worker}`,
        runAsync: true,
      });
    });
    await timed("worker: wait ready", () => this.waitForWorker(sandbox, cmdId, events));
    // Returned so the caller can record it and later confirm this worker is still
    // alive before reusing it on a subsequent run.
    return cmdId;
  }

  // Polls the worker session log until it prints "Worker started" (emitted right
  // after Worker.create resolves - workflows bundled, connection ready). Waiting
  // on that signal beats a fixed sleep: a fast ts-node start no longer pays the
  // full delay, and a slow one isn't raced. Falls back after ~30s so a crashed
  // worker still lets the run proceed (and fail with a useful client error).
  async waitForWorker(sandbox, cmdId, events) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      let logs;
      try {
        logs = await sandbox.process.getSessionCommandLogs("worker", cmdId);
      } catch {
        /* session not queryable yet - retry */
      }
      const text = logs?.stdout || logs?.output || "";
      if (text.includes("Worker started")) return;
      await sleep(750);
    }
    events.log("Worker did not report ready within 30s; proceeding anyway.");
  }

  // Runs the client once and returns its output. We launch it as an async session
  // command and poll for completion instead of using a fixed command timeout, so
  // a slow first run (e.g. ts-node cold start) doesn't time out prematurely.
  async runStarter(sandbox, module, events) {
    events.log("Submitting loan application...");
    events.log(`$ ${module.starter}`);

    // Give the client the sandbox's Temporal UI URL so its "Watch it at ..."
    // link points at this sandbox (not localhost). Falls back to localhost in the
    // client when unset. Single-quoted so the signed URL's query is shell-safe.
    let uiEnv = "";
    try {
      uiEnv = `TEMPORAL_UI_URL='${await this.getPreviewUrl(sandbox)}' `;
    } catch (err) {
      events.log(`Could not resolve Temporal UI URL: ${err.message}`);
    }

    // A fresh session each run; drop any leftover one so a re-run cleanly
    // supersedes (and kills) a previous client command.
    const { cmdId } = await timed("starter: start command", async () => {
      try {
        await sandbox.process.deleteSession("starter");
      } catch {
        /* no previous starter session */
      }
      await sandbox.process.createSession("starter");
      return sandbox.process.executeSessionCommand("starter", {
        command: `cd ${appDir} && ${uiEnv}${module.starter}`,
        runAsync: true,
      });
    });

    const startedAt = Date.now();
    const deadline = startedAt + starterTimeoutMs;
    let command;
    while (Date.now() < deadline) {
      command = await sandbox.process.getSessionCommand("starter", cmdId);
      if (command?.exitCode !== null && command?.exitCode !== undefined) break;
      events.spinner(`Waiting for the client to finish (${Math.round((Date.now() - startedAt) / 1000)}s)...`);
      await sleep(400);
    }
    events.spinner("");
    debugLog(`starter: client run ${Date.now() - startedAt}ms exit=${command?.exitCode ?? "none"}`);

    // Prefer the clean stdout channel (where the client's console.log lands).
    const logs = await timed("starter: fetch logs", () =>
      sandbox.process.getSessionCommandLogs("starter", cmdId),
    );
    const output = (logs?.stdout || logs?.output || "").trim();
    try {
      await sandbox.process.deleteSession("starter");
    } catch {
      /* best-effort cleanup */
    }

    if (command?.exitCode === null || command?.exitCode === undefined) {
      throw new Error("Client did not finish in time - is the worker running?");
    }
    if (command.exitCode !== 0) throw new Error(`Client run failed: ${output}`);
    events.log("Client output:");
    for (const line of output.split("\n")) events.log(`  ${line}`);
    return output;
  }

  // Long-poll helper behind /api/await-result. Blocks (up to ~55s) on the Temporal
  // CLI's `workflow result`, which returns once the workflow closes. The browser
  // calls this repeatedly after a run; when it finally reports completed (which
  // for signal-driven modules is after the learner sends the signal, and after a
  // worker restart in the durability demo) the UI fires confetti. Returns
  // { completed, result } or { gone: true } if the sandbox is no longer there.
  async awaitWorkflowResult(sandboxId, workflowId) {
    let sandbox;
    try {
      sandbox = await timed(`daytona.get ${sandboxId} (await-result)`, () =>
        this.daytona.get(sandboxId),
      );
    } catch {
      return { gone: true };
    }
    // A blocking poll: it either returns once the workflow closes or times out
    // while it's still open. Log the outcome/duration without treating an
    // expected timeout as a failure (so it doesn't read as an error).
    const start = Date.now();
    try {
      const res = await sandbox.process.executeCommand(
        `${temporalBin} workflow result --workflow-id ${workflowId} --address localhost:7233 2>&1`,
        undefined,
        undefined,
        55,
      );
      if (res?.exitCode === 0) {
        debugLog(`awaitResult ${workflowId} completed ${Date.now() - start}ms`);
        return { completed: true, result: (res.result || res.output || "").trim() };
      }
      debugLog(`awaitResult ${workflowId} still-open ${Date.now() - start}ms`);
    } catch {
      /* timeout while the workflow is still open, or a transient blip - the
         browser will poll again. */
      debugLog(`awaitResult ${workflowId} poll-ended ${Date.now() - start}ms`);
    }
    return { completed: false };
  }

  async waitForTemporal(sandbox, sessionId, cmdId, events) {
    const deadline = Date.now() + 120_000;
    // Poll from the start instead of blindly waiting a few seconds first: the
    // dev server usually boots in 1-2s, and the health check itself fails fast
    // until then. A tight interval means we proceed the moment it's ready.
    while (Date.now() < deadline) {
      const result = await sandbox.process.executeCommand(
        `${temporalBin} operator cluster health 2>&1`,
        undefined,
        undefined,
        10,
      );
      if (result.exitCode === 0) return;
      await sleep(400);
    }
    try {
      const logs = await sandbox.process.getSessionCommandLogs(sessionId, cmdId);
      const tail = (logs?.output || logs?.stderr || logs?.stdout || "").trim();
      if (tail) {
        events.log("temporal-server output:");
        for (const line of tail.split("\n").slice(-20)) events.log(`  ${line}`);
      }
    } catch (err) {
      events.log(`Could not fetch Temporal server logs: ${err.message}`);
    }
    throw new Error("Temporal dev server did not become healthy within 120 seconds");
  }
}

let manager;
function getManager() {
  if (!manager) manager = new CourseSandboxManager();
  return manager;
}

// What the browser needs to reach the UI proxy: an explicit public base when set,
// otherwise the port to combine with the page's own hostname.
function uiProxyInfo() {
  return { uiProxyBase: uiProxyPublicBase, uiProxyPort: uiProxyPublicBase ? null : uiProxyPort };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

// Headers we never forward upstream: hop-by-hop or recomputed by fetch/undici.
const proxyDropRequestHeaders = new Set(["host", "connection", "content-length", "accept-encoding"]);
// Response headers we drop or special-case before relaying to the browser. We set
// content-encoding/length ourselves, so the upstream's (the body fetch already
// decoded) are dropped here.
const proxyDropResponseHeaders = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "set-cookie",
  "location",
]);

// Text-ish bodies worth gzipping on the browser-facing hop. The sandbox dev server
// serves the Temporal UI uncompressed, and fetch() decodes anything it does encode,
// so without this we'd ship multi-MB of JS in the clear over a cross-region link.
const proxyCompressible = /^(?:text\/|application\/(?:javascript|json|manifest\+json|xml|wasm)|image\/svg\+xml)/i;
function clientAcceptsGzip(req) {
  return /\bgzip\b/i.test(req.headers["accept-encoding"] || "");
}
function clientAcceptsBr(req) {
  return /\bbr\b/i.test(req.headers["accept-encoding"] || "");
}
// Brotli beats gzip ~15% on JS; quality 10 keeps the one-off compress fast while
// staying close to max ratio. Cheap overall since asset results are cached.
const brotliOpts = (size) => ({
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 10,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size || 0,
  },
});
// Picks the best encoding the client accepts and returns the matching bytes,
// memoizing the compressed copies on the entry so repeat hits skip the work.
function encodeBody(req, entry) {
  if (entry.compressible !== false) {
    if (clientAcceptsBr(req)) {
      entry.br ??= zlib.brotliCompressSync(entry.body, brotliOpts(entry.body.length));
      return { encoding: "br", buf: entry.br };
    }
    if (clientAcceptsGzip(req)) {
      entry.gzip ??= zlib.gzipSync(entry.body);
      return { encoding: "gzip", buf: entry.gzip };
    }
  }
  return { encoding: null, buf: entry.body };
}

// In-process cache for the Temporal UI's content-hashed assets. They're immutable
// and identical across sandboxes (same Temporal version), so keying by path alone
// lets later loads — and other students — skip both the Daytona round trip and the
// gzip work. Bounded with simple FIFO eviction.
const uiAssetCache = new Map();
const uiAssetCacheMax = 1024;
function isImmutableAsset(pathname) {
  return pathname.startsWith("/_app/immutable/");
}
function cacheAsset(pathname, entry) {
  if (uiAssetCache.size >= uiAssetCacheMax) uiAssetCache.delete(uiAssetCache.keys().next().value);
  uiAssetCache.set(pathname, entry);
}

// Injected into every proxied Temporal UI HTML document. The iframe's `load` event
// fires when the document arrives, but the SvelteKit SPA then boots and renders for
// a beat longer — and the embedding page is a different origin, so it can't see when
// that finishes. So we put the loading overlay *inside* the page: it paints with the
// HTML and removes itself once real UI content appears (or after a safety timeout),
// covering the otherwise-white SPA boot.
const uiLoaderInjection = `<style>
#__course_loading{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;
align-items:center;justify-content:center;gap:14px;background:#1d1d20;color:#e7ebf2;
font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;transition:opacity .25s ease}
#__course_loading .__s{width:30px;height:30px;border-radius:50%;border:3px solid rgba(231,235,242,.25);
border-top-color:#818cf8;animation:__cspin .8s linear infinite}
@keyframes __cspin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){#__course_loading .__s{animation-duration:2s}}
</style>
<div id="__course_loading"><div class="__s"></div><div>Loading the workflow…</div></div>
<script>(function(){var el=document.getElementById('__course_loading');
function done(){if(!el)return;var node=el;el=null;node.style.pointerEvents='none';node.style.opacity='0';setTimeout(function(){if(node.parentNode)node.parentNode.removeChild(node);},250);}
function ready(){return!!document.querySelector('main,nav,header,[data-testid]')||document.body.querySelectorAll('*').length>40;}
function reply(m){try{parent.postMessage(m,'*');}catch(e){}}
var announced=false;function announce(){if(announced)return;announced=true;reply({__course:'ready'});}
if(el){var obs=new MutationObserver(function(){if(ready()){obs.disconnect();done();announce();}});
try{obs.observe(document.documentElement,{childList:true,subtree:true});}catch(e){}
setTimeout(function(){if(ready()){obs.disconnect();done();announce();}},400);
setTimeout(function(){try{obs.disconnect();}catch(e){}done();announce();},15000);}else{announce();}
// Client-side navigation requested by the embedding page: a constructed MouseEvent
// click on an in-app link makes SvelteKit's router navigate without a full document
// reload (a bare .click() fails its which===1 check, causing a hard navigation). We
// confirm via the pathname and report navok/navfail so the parent can hard-load as a
// last resort.
window.addEventListener('message',function(e){var d=e.data;if(!d||d.__course!=='nav'||!d.path)return;
try{var root=document.getElementById('svelte')||document.body;var a=document.createElement('a');a.href=d.path;root.appendChild(a);
// dispatchEvent returns false when a listener calls preventDefault — i.e. SvelteKit's
// router intercepted the click and is navigating client-side (no reload). If it isn't
// prevented the click would do a hard navigation, so report navfail and let the parent
// hard-load instead.
var prevented=!a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,button:0}));
setTimeout(function(){if(a.parentNode)a.remove();},0);
reply({__course:prevented?'navok':'navfail',path:d.path});
}catch(err){reply({__course:'navfail',path:d.path});}});})();</script>`;

// Drops the loader overlay markup in right after the opening <body> tag so it paints
// before anything else; falls back to prepending if no <body> is found. Also strips
// the Temporal UI's CSP <meta> (we already strip the CSP header): its script-src
// 'strict-dynamic' would otherwise block the injected loader-removal script.
function injectUiLoader(html) {
  const stripped = html.replace(
    /<meta[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/gi,
    "",
  );
  const match = stripped.match(/<body[^>]*>/i);
  return match ? stripped.replace(match[0], match[0] + uiLoaderInjection) : uiLoaderInjection + stripped;
}

// Sends a cached/just-fetched immutable asset in the best encoding the client
// accepts (brotli > gzip > identity), memoized on the entry.
function sendCachedAsset(req, res, entry) {
  const headers = {
    "content-type": entry.contentType,
    "cache-control": "public, max-age=31536000, immutable",
    vary: "Accept-Encoding",
  };
  const { encoding, buf } = encodeBody(req, entry);
  if (encoding) headers["content-encoding"] = encoding;
  headers["content-length"] = buf.length;
  res.writeHead(entry.status, headers);
  res.end(req.method === "HEAD" ? undefined : buf);
}

// Same-origin reverse proxy for the sandbox's Temporal Web UI (see uiProxyPort
// notes above). It mirrors every request to the pinned sandbox's signed UI URL,
// drops the framing headers so the page can live in an iframe, and re-scopes the
// upstream's auth cookies to this host so they survive in the embedded context.
const uiProxyServer = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url ?? "/", `http://${host}:${uiProxyPort}`);
    const cookies = parseCookies(req.headers.cookie);
    // The pane points the iframe at `…?__s=<sandboxId>`; we pin that to a cookie so
    // the UI's later root-absolute requests (which drop the query) still resolve.
    const pin = reqUrl.searchParams.get("__s");
    const sandboxId = pin || cookies[uiProxyCookie];
    if (pin) reqUrl.searchParams.delete("__s");
    if (!sandboxId) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("No sandbox selected. Open the Temporal UI from the course pane.");
      return;
    }

    // Immutable assets are version-keyed, so a cache hit skips the sandbox entirely.
    const cacheable = (req.method === "GET" || req.method === "HEAD") && isImmutableAsset(reqUrl.pathname);
    if (cacheable) {
      const hit = uiAssetCache.get(reqUrl.pathname);
      if (hit) {
        sendCachedAsset(req, res, hit);
        return;
      }
    }

    let base;
    try {
      base = (await getManager().previewBaseFor(sandboxId)).replace(/\/$/, "");
    } catch (err) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`Sandbox unavailable: ${err.message}`);
      return;
    }

    const fwdHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (proxyDropRequestHeaders.has(key.toLowerCase())) continue;
      fwdHeaders[key] = value;
    }
    // Strip our own pin cookie so only the upstream's cookies reach upstream.
    if (req.headers.cookie) {
      const upstreamCookie = req.headers.cookie
        .split(";")
        .map((c) => c.trim())
        .filter((c) => c && !c.startsWith(`${uiProxyCookie}=`))
        .join("; ");
      if (upstreamCookie) fwdHeaders.cookie = upstreamCookie;
      else delete fwdHeaders.cookie;
    }

    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }

    const upstream = await fetch(`${base}${reqUrl.pathname}${reqUrl.search}`, {
      method: req.method,
      headers: fwdHeaders,
      body,
      redirect: "manual",
    });

    const outHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (!proxyDropResponseHeaders.has(key.toLowerCase())) outHeaders[key] = value;
    });
    // Keep redirects on the proxy origin by relativizing upstream Location values.
    const location = upstream.headers.get("location");
    if (location) outHeaders.location = location.startsWith(base) ? location.slice(base.length) || "/" : location;

    // Re-scope upstream cookies to this host (drop Domain so they're host-only,
    // and Secure so they survive plain-http local dev), and (re)set the pin.
    const setCookies = (upstream.headers.getSetCookie?.() ?? []).map((cookie) =>
      cookie.replace(/;\s*Domain=[^;]*/i, "").replace(/;\s*Secure/i, ""),
    );
    if (pin) setCookies.push(`${uiProxyCookie}=${sandboxId}; Path=/; SameSite=Lax`);
    if (setCookies.length) outHeaders["set-cookie"] = setCookies;

    const contentType = upstream.headers.get("content-type") || "";
    const compressible = upstream.status === 200 && proxyCompressible.test(contentType);

    // Cache immutable assets (compressing once, lazily per encoding) so reloads and
    // other students skip the round trip; buffer the body to do so.
    if (cacheable && upstream.status === 200) {
      const entry = { status: 200, contentType, body: Buffer.from(await upstream.arrayBuffer()), compressible };
      cacheAsset(reqUrl.pathname, entry);
      sendCachedAsset(req, res, entry);
      return;
    }

    // Inject the in-page loader into HTML documents so the overlay survives the SPA
    // boot. Buffer it (HTML is small) so we can rewrite then compress.
    if (/\btext\/html\b/i.test(contentType) && upstream.status === 200) {
      const html = Buffer.from(injectUiLoader(Buffer.from(await upstream.arrayBuffer()).toString("utf8")), "utf8");
      const { encoding, buf } = encodeBody(req, { body: html, compressible: true });
      if (encoding) outHeaders["content-encoding"] = encoding;
      outHeaders.vary = "Accept-Encoding";
      outHeaders["content-length"] = buf.length;
      res.writeHead(upstream.status, outHeaders);
      res.end(req.method === "HEAD" ? undefined : buf);
      return;
    }

    if (!upstream.body) {
      res.writeHead(upstream.status, outHeaders);
      res.end();
      return;
    }

    // Stream everything else, gzipping compressible bodies on the fly. (Streamed
    // responses — mostly the dynamic data API — favor gzip's lower per-call cost
    // over brotli; the heavy, cacheable assets above get brotli.)
    const source = Readable.fromWeb(upstream.body);
    if (compressible && clientAcceptsGzip(req)) {
      outHeaders["content-encoding"] = "gzip";
      outHeaders.vary = "Accept-Encoding";
      res.writeHead(upstream.status, outHeaders);
      source.pipe(zlib.createGzip()).pipe(res);
    } else {
      res.writeHead(upstream.status, outHeaders);
      source.pipe(res);
    }
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`UI proxy error: ${err.message}`);
  }
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        daytona: Boolean(process.env.DAYTONA_KEY),
        ...uiProxyInfo(),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/typecheck") {
      const body = await readJson(req);
      const diagnostics = await typecheckModule(body);
      json(res, 200, { diagnostics });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      const body = await readJson(req);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      const events = {
        log: (message) => writeSse(res, "log", message),
        spinner: (message) => writeSse(res, "spinner", message),
      };
      const result = await getManager().run(body, events, (ui) =>
        writeSse(res, "ui", { ...ui, ...uiProxyInfo() }),
      );
      writeSse(res, "result", { ...result, ...uiProxyInfo() });
      writeSse(res, "done", null);
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/await-result") {
      const body = await readJson(req);
      if (!body.sandboxId || !body.workflowId) {
        json(res, 400, { error: "sandboxId and workflowId required" });
        return;
      }
      const result = await getManager().awaitWorkflowResult(body.sandboxId, body.workflowId);
      json(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/stop") {
      const body = await readJson(req);
      if (!body.sandboxId) {
        json(res, 400, { error: "sandboxId required" });
        return;
      }
      if (body.target === "worker") {
        await getManager().stopWorker(body.sandboxId);
      } else {
        await getManager().stop(body.sandboxId);
      }
      json(res, 200, { ok: true });
      return;
    }

    if (distDir && (req.method === "GET" || req.method === "HEAD") && !url.pathname.startsWith("/api/")) {
      await serveStatic(req, res, url.pathname);
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    if (res.headersSent) {
      writeSse(res, "error", err.message);
      writeSse(res, "done", null);
      res.end();
    } else {
      json(res, 500, { error: err.message });
    }
  }
});

server.listen(port, host, () => {
  console.log(`Course runner listening on http://${host}:${port}`);
});

uiProxyServer.listen(uiProxyPort, host, () => {
  console.log(`Temporal UI proxy listening on http://${host}:${uiProxyPort}`);
});
