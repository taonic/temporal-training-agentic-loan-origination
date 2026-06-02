import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { Daytona, Image } from "@daytonaio/sdk";

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

async function resolveModule(moduleId) {
  if (!/^module-\d+/.test(moduleId ?? "")) {
    throw new Error("moduleId must be a module directory such as module-1-durable-pipeline");
  }
  const moduleDir = path.join(rootDir, moduleId);
  await fs.access(path.join(moduleDir, "starter", "src"));
  const files = await sourceFilePaths(moduleId);
  const scenario = starterScenarios[moduleId] ?? "";
  const starterCmd = `npx ts-node ${moduleId}/starter/src/client.ts${scenario ? ` ${scenario}` : ""}`;
  return {
    id: moduleId,
    // Base dir used when reading pristine source files from disk.
    dir: path.join(moduleDir, "starter"),
    files,
    worker: `npx ts-node ${moduleId}/starter/src/worker.ts`,
    starter: starterCmd,
    workerProcessPattern: `${moduleId}/starter/src/worker.ts`,
    // The workflow id the client uses (bad-ssn scenario uses LOAN-002). The
    // browser polls /api/await-result with this to celebrate completion.
    workflowId: scenario === "bad-ssn" ? "LOAN-002" : "LOAN-001",
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
  }

  // Dispatches a run request. `action` selects which parts run:
  //   "worker"  - (re)start the long-running worker, creating the sandbox if needed
  //   "starter" - run the client once against an already-running worker
  //   "all"     - the combined flow: (re)start the worker, then run the client
  async run({ action = "all", sandboxId, exerciseId, files }, events, onUiReady) {
    const module = await resolveModule(exerciseId);
    const wantWorker = action === "all" || action === "worker";
    const wantStarter = action === "all" || action === "starter";

    let sandbox = sandboxId ? await this.resolveRunningSandbox(sandboxId, events) : null;
    let uiInfo = {};
    let created = false;
    if (sandbox) {
      await this.uploadModule(sandbox, module, files);
    } else {
      // No usable sandbox (never created, or the previous one expired) - make a
      // fresh one. createSandbox brings up Temporal (and, for Module 4, injects
      // the LLM proxy env) and emits the new UI info.
      ({ sandbox, uiInfo } = await this.createSandbox(module, files, events, onUiReady));
      created = true;
    }

    // A freshly created sandbox has no worker yet, so even a starter-only run
    // must start one first.
    const mustStartWorker = wantWorker || (created && wantStarter);
    try {
      if (mustStartWorker) await this.startWorker(sandbox, module, events);
      const out = {};
      if (wantStarter) out.workflowResult = await this.runStarter(sandbox, module, events);
      // We hand back the workflow id; the browser then polls /api/await-result and
      // celebrates when the workflow actually completes — which for modules that
      // pause for a human signal happens after the learner sends it, and after a
      // worker restart in the durability demo. One uniform "you did it" moment.
      return { ...uiInfo, sandboxId: sandbox.id, workflowId: module.workflowId, ...out };
    } catch (err) {
      if (created) {
        events.log(`Launch failed: ${err.message}. Cleaning up sandbox...`);
        try {
          await sandbox.delete();
        } catch (cleanupErr) {
          events.log(`Cleanup error ignored: ${cleanupErr.message}`);
        }
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
      sandbox = await this.daytona.get(sandboxId);
    } catch (err) {
      events.log(`Sandbox ${sandboxId} is gone (${err.message}). Starting a new one...`);
      return null;
    }
    try {
      await sandbox.refreshData();
    } catch {
      /* best effort - fall back to whatever state get() returned */
    }
    if (sandbox.state && sandbox.state !== "started") {
      events.log(`Sandbox ${sandboxId} is ${sandbox.state}. Starting a new one...`);
      try {
        await sandbox.delete();
      } catch {
        /* it will be auto-deleted anyway */
      }
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
      envVars.OPENAI_BASE_URL = `${llmProxyUrl}/v1`;
      envVars.OPENAI_API_KEY = llmProxyKey;
      envVars.AGENT_MODEL = agentModel;
    }

    const sandbox = await this.daytona.create(
      {
        image: runtimeImage(),
        language: "typescript",
        envVars,
        autoStopInterval: 15,
        autoDeleteInterval: 30,
        resources: { disk: 1, memory: 2 },
      },
      { timeout: 120 },
    );

    try {
      events.log(`Sandbox created: ${sandbox.id}`);
      await this.uploadModule(sandbox, module, files);
      await this.startTemporal(sandbox, events);
      const preview = await sandbox.getSignedPreviewUrl(temporalUiPort, 3600);
      const uiInfo = { sandboxId: sandbox.id, uiUrl: preview.url };
      events.log(`Temporal UI: ${preview.url}`);
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
  }

  async stopWorker(sandboxId) {
    const sandbox = await this.daytona.get(sandboxId);
    await sandbox.process.executeCommand(`pkill -f "starter/src/worker.ts" 2>/dev/null; true`);
    try {
      await sandbox.process.deleteSession("worker");
    } catch {
      /* no worker session */
    }
  }

  async uploadModule(sandbox, module, files) {
    await sandbox.fs.uploadFile(await fs.readFile(tsconfigPath), `${appDir}/tsconfig.json`);
    const dirs = new Set([
      `${appDir}/${module.id}`,
      `${appDir}/${module.id}/starter`,
      `${appDir}/${module.id}/starter/src`,
    ]);
    for (const file of module.files) {
      const remotePath = `${appDir}/${module.id}/starter/src/${file}`;
      dirs.add(path.posix.dirname(remotePath));
    }
    for (const dir of [...dirs].sort((a, b) => a.length - b.length)) {
      try {
        await sandbox.fs.createFolder(dir, "755");
      } catch {
        /* already exists */
      }
    }
    for (const file of module.files) {
      // The browser posts edited files keyed by their tab path ("src/foo.ts");
      // fall back to the pristine source on disk when a file wasn't edited.
      const incoming = files?.[`src/${file}`] ?? files?.[file];
      const content =
        incoming === undefined
          ? await fs.readFile(path.join(module.dir, "src", file), "utf8")
          : String(incoming).replace(/\r\n/g, "\n");
      await sandbox.fs.uploadFile(Buffer.from(content), `${appDir}/${module.id}/starter/src/${file}`);
    }
  }

  async startTemporal(sandbox, events) {
    events.log("Starting Temporal dev server...");
    await sandbox.process.createSession("temporal-server");
    const response = await sandbox.process.executeSessionCommand("temporal-server", {
      command: `${temporalBin} server start-dev --ip 0.0.0.0 --ui-ip 0.0.0.0 --log-level warn`,
      runAsync: true,
    });
    await this.waitForTemporal(sandbox, "temporal-server", response.cmdId, events);
  }

  // (Re)starts the long-running worker. Killing any existing worker first makes
  // this safe to call whether or not one is already running.
  async startWorker(sandbox, module, events) {
    events.log("Stopping previous worker...");
    await sandbox.process.executeCommand(`pkill -f "${module.workerProcessPattern}" 2>/dev/null; true`);
    try {
      await sandbox.process.deleteSession("worker");
    } catch {
      /* no worker session */
    }

    events.log("Starting worker...");
    events.log(`$ ${module.worker}`);
    await sandbox.process.createSession("worker");
    await sandbox.process.executeSessionCommand("worker", {
      command: `cd ${appDir} && ${module.worker}`,
      runAsync: true,
    });
    await sleep(3000);
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
      const ui = await sandbox.getSignedPreviewUrl(temporalUiPort, 3600);
      uiEnv = `TEMPORAL_UI_URL='${ui.url}' `;
    } catch (err) {
      events.log(`Could not resolve Temporal UI URL: ${err.message}`);
    }

    // A fresh session each run; drop any leftover one so a re-run cleanly
    // supersedes (and kills) a previous client command.
    try {
      await sandbox.process.deleteSession("starter");
    } catch {
      /* no previous starter session */
    }
    await sandbox.process.createSession("starter");
    const { cmdId } = await sandbox.process.executeSessionCommand("starter", {
      command: `cd ${appDir} && ${uiEnv}${module.starter}`,
      runAsync: true,
    });

    const startedAt = Date.now();
    const deadline = startedAt + starterTimeoutMs;
    let command;
    while (Date.now() < deadline) {
      command = await sandbox.process.getSessionCommand("starter", cmdId);
      if (command?.exitCode !== null && command?.exitCode !== undefined) break;
      events.spinner(`Waiting for the client to finish (${Math.round((Date.now() - startedAt) / 1000)}s)...`);
      await sleep(1500);
    }
    events.spinner("");

    // Prefer the clean stdout channel (where the client's console.log lands).
    const logs = await sandbox.process.getSessionCommandLogs("starter", cmdId);
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
      sandbox = await this.daytona.get(sandboxId);
    } catch {
      return { gone: true };
    }
    try {
      const res = await sandbox.process.executeCommand(
        `${temporalBin} workflow result --workflow-id ${workflowId} --address localhost:7233 2>&1`,
        undefined,
        undefined,
        55,
      );
      if (res?.exitCode === 0) {
        return { completed: true, result: (res.result || res.output || "").trim() };
      }
    } catch {
      /* timeout while the workflow is still open, or a transient blip - the
         browser will poll again. */
    }
    return { completed: false };
  }

  async waitForTemporal(sandbox, sessionId, cmdId, events) {
    const deadline = Date.now() + 120_000;
    await sleep(3000);
    while (Date.now() < deadline) {
      const result = await sandbox.process.executeCommand(
        `${temporalBin} operator cluster health 2>&1`,
        undefined,
        undefined,
        10,
      );
      if (result.exitCode === 0) return;
      await sleep(2000);
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        daytona: Boolean(process.env.DAYTONA_KEY),
      });
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
      const result = await getManager().run(body, events, (ui) => writeSse(res, "ui", ui));
      writeSse(res, "result", result);
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
