import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const courseDir = path.join(rootDir, "course");
const outputPath = path.join(courseDir, "course-data.js");

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".json"]);
// Reading order in the editor's file tabs: the workflow you edit first, then its
// supporting code, then the worker/client you run.
const preferredOrder = [
  "src/workflows.ts",
  "src/agent-workflow.ts",
  "src/activities.ts",
  "src/agent-activities.ts",
  "src/models.ts",
  "src/worker.ts",
  "src/client.ts",
];
const inputFiles = [];

function sortFiles(a, b) {
  const ai = preferredOrder.indexOf(a.path);
  const bi = preferredOrder.indexOf(b.path);
  if (ai !== -1 || bi !== -1) {
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  }
  return a.path.localeCompare(b.path);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readInputFile(filePath) {
  inputFiles.push(filePath);
  return fs.readFile(filePath, "utf8");
}

async function walk(dir, baseDir = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(abs, baseDir)));
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(path.relative(baseDir, abs).split(path.sep).join("/"));
    }
  }
  return files;
}

function titleFromReadme(markdown, fallback) {
  const line = markdown
    .split("\n")
    .find((item) => item.startsWith("# "));
  return line ? line.replace(/^#\s+/, "").trim() : fallback;
}

function durationFromTitle(title) {
  const match = title.match(/\(([^)]+)\)\s*$/);
  return match ? match[1] : "";
}

// Each module dir (e.g. module-1-durable-pipeline) holds a `starter/` (the files
// the learner edits) and a matching `solution/`. The editor shows the starter
// files, with the solution available behind the "Switch to solution" toggle.
async function readModule(entry) {
  const number = Number(entry.name.match(/^module-(\d+)/)[1]);
  const moduleDir = path.join(rootDir, entry.name);
  const readmePath = path.join(moduleDir, "README.md");
  // Online guide: step-by-step instructions tailored to the click-to-run browser
  // environment. Falls back to the generic README when absent.
  const guidePath = path.join(moduleDir, "ONLINE_GUIDE.md");
  const readme = await readInputFile(readmePath);

  const starterRoot = path.join(moduleDir, "starter");
  const solutionRoot = path.join(moduleDir, "solution");

  const solutionContent = {};
  if (await exists(path.join(solutionRoot, "src"))) {
    const solutionPaths = await walk(path.join(solutionRoot, "src"), solutionRoot);
    await Promise.all(
      solutionPaths.map(async (filePath) => {
        solutionContent[filePath] = await readInputFile(path.join(solutionRoot, filePath));
      }),
    );
  }

  const sourcePaths = await walk(path.join(starterRoot, "src"), starterRoot);
  const files = await Promise.all(
    sourcePaths.map(async (filePath) => {
      const file = {
        path: filePath,
        content: await readInputFile(path.join(starterRoot, filePath)),
      };
      if (filePath in solutionContent) file.solution = solutionContent[filePath];
      return file;
    }),
  );

  const title = titleFromReadme(readme, `Module ${number}`);

  return {
    id: entry.name,
    number,
    title,
    duration: durationFromTitle(title),
    root: entry.name,
    readme,
    sandbox: (await exists(guidePath)) ? await readInputFile(guidePath) : "",
    solution: "",
    files: files.sort(sortFiles),
  };
}

const entries = await fs.readdir(rootDir, { withFileTypes: true });
const exercises = (
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^module-\d+/.test(entry.name))
      .map(readModule),
  )
).sort((a, b) => a.number - b.number);
const generatedAt = new Date(
  Math.max(...(await Promise.all(inputFiles.map(async (filePath) => (await fs.stat(filePath)).mtimeMs)))),
).toISOString();

const data = {
  generatedAt,
  title: "Temporal Agentic Loan Origination",
  exercises,
};

const json = JSON.stringify(data, null, 2)
  .replace(/<\/script/gi, "<\\/script")
  .replace(/\u2028/g, "\\u2028")
  .replace(/\u2029/g, "\\u2029")

await fs.mkdir(courseDir, { recursive: true });
const contents = `window.COURSE_DATA = ${json};\n`;
// Only write when the content actually changed so watch/rebuild pipelines that
// regenerate on every build don't loop on their own output.
const existing = await fs.readFile(outputPath, "utf8").catch(() => null);
if (existing === contents) {
  console.log(`Course data unchanged (${exercises.length} modules).`);
} else {
  await fs.writeFile(outputPath, contents);
  console.log(`Built ${path.relative(rootDir, outputPath)} with ${exercises.length} modules.`);
}
