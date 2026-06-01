import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const execFileAsync = promisify(execFile);
const courseDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(courseDir, "..");
const buildScript = path.join(repoRoot, "scripts", "build-course-site.mjs");

// Every module source + README file that feeds course-data.js, so edits to them
// can trigger a regenerate + reload.
function collectCourseInputs() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(md|ts|tsx|js|json)$/.test(entry.name)) files.push(abs);
    }
  };
  for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && /^module-\d+/.test(entry.name)) {
      walk(path.join(repoRoot, entry.name));
    }
  }
  return files;
}

// Regenerates course-data.js from the module content and keeps it in sync as
// those files change (under `vite`, `vite build --watch`, and so `course:preview`).
function courseData() {
  const generate = () => execFileAsync(process.execPath, [buildScript]);
  return {
    name: "course-data",
    async buildStart() {
      await generate();
      // Rollup (build --watch) reruns the build, and thus buildStart, when any
      // of these change. The idempotent generator keeps it from looping.
      for (const file of collectCourseInputs()) this.addWatchFile(file);
    },
    configureServer(server) {
      const inputs = new Set(collectCourseInputs());
      server.watcher.add([...inputs]);
      server.watcher.on("change", async (file) => {
        if (!inputs.has(path.resolve(file))) return;
        await generate();
        server.ws.send({ type: "full-reload" });
      });
    },
  };
}

export default defineConfig({
  root: courseDir,
  plugins: [vue(), courseData()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
