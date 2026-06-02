export const storagePrefix = "temporal-loan-course";

export function storageKey(...parts) {
  return [storagePrefix, ...parts].join(":");
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const TS_KEYWORDS = [
  "abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch",
  "class", "const", "continue", "debugger", "declare", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "from", "function",
  "get", "if", "implements", "import", "in", "infer", "instanceof", "interface", "is",
  "keyof", "let", "namespace", "never", "new", "null", "number", "object", "of",
  "private", "protected", "public", "readonly", "return", "set", "static", "string",
  "super", "switch", "symbol", "this", "throw", "true", "try", "type", "typeof",
  "undefined", "unknown", "var", "void", "while", "yield",
];

// Ordered token rules. Each rule's source is wrapped in exactly one capture group
// when combined, so the matched group index maps directly back to the rule.
const HL_RULES = [
  ["comment", /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
  ["string", /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/],
  ["number", /\b0[xXbBoO][\da-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
  ["keyword", new RegExp(`\\b(?:${TS_KEYWORDS.join("|")})\\b`)],
  ["decorator", /@[A-Za-z_]\w*/],
  ["function", /[A-Za-z_]\w*(?=\s*\()/],
  ["type", /\b[A-Z]\w*\b/],
];

const HL_COMBINED = new RegExp(HL_RULES.map(([, re]) => `(${re.source})`).join("|"), "g");

// Lightweight, dependency-free syntax highlighter for the TypeScript/JS exercise
// files. Returns HTML-escaped markup with <span class="tok-*"> wrappers.
export function highlightCode(code) {
  const source = String(code);
  HL_COMBINED.lastIndex = 0;
  let html = "";
  let lastIndex = 0;
  let match;
  while ((match = HL_COMBINED.exec(source)) !== null) {
    if (match.index > lastIndex) {
      html += escapeHtml(source.slice(lastIndex, match.index));
    }
    const groupIndex = match.slice(1).findIndex((group) => group !== undefined);
    const [type] = HL_RULES[groupIndex];
    html += `<span class="tok-${type}">${escapeHtml(match[0])}</span>`;
    lastIndex = HL_COMBINED.lastIndex;
    if (HL_COMBINED.lastIndex === match.index) HL_COMBINED.lastIndex += 1;
  }
  html += escapeHtml(source.slice(lastIndex));
  return html;
}

export function inlineMarkdown(value) {
  let output = escapeHtml(value);
  output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const safeHref = String(href).startsWith("javascript:") ? "#" : href;
    return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener">${label}</a>`;
  });
  return output;
}

export function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let list = null;
  let inCode = false;
  let codeLines = [];
  let codeLanguage = "";

  const closeList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  const closeCode = () => {
    const source = codeLines.join("\n");
    const highlightable = /^(ts|tsx|typescript|js|jsx|javascript)$/i.test(codeLanguage);
    const body = highlightable ? highlightCode(source) : escapeHtml(source);
    html.push(
      `<pre><code data-language="${escapeHtml(codeLanguage)}">${body}</code></pre>`,
    );
    inCode = false;
    codeLines = [];
    codeLanguage = "";
  };

  // Consecutive plain-text lines form one paragraph: hard line wraps in the
  // source are soft breaks, so they're joined with a space rather than each
  // becoming its own <p> (which showed up as artificial line breaks).
  let para = [];
  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${inlineMarkdown(para.join(" "))}</p>`);
      para = [];
    }
  };

  // Split a GFM table row into trimmed cells, ignoring the optional outer pipes.
  const splitRow = (row) =>
    row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```(\S*)/);
    if (fence) {
      if (inCode) {
        closeCode();
      } else {
        flushPara();
        closeList();
        inCode = true;
        codeLanguage = fence[1] ?? "";
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    // Thematic break: a line of 3+ of -, *, or _ and nothing else.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara();
      closeList();
      html.push("<hr>");
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      flushPara();
      if (list !== "ol") {
        closeList();
        list = "ol";
        html.push("<ol>");
      }
      html.push(`<li>${inlineMarkdown(ordered[1])}</li>`);
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    if (unordered) {
      flushPara();
      if (list !== "ul") {
        closeList();
        list = "ul";
        html.push("<ul>");
      }
      html.push(`<li>${inlineMarkdown(unordered[1])}</li>`);
      continue;
    }

    // GFM table: a header row (contains a pipe) immediately followed by a
    // |---|---| separator row, then body rows until a blank/non-pipe line.
    const sep = lines[i + 1];
    const isTable =
      line.includes("|") &&
      sep &&
      sep.includes("|") &&
      sep.includes("-") &&
      /^[\s|:-]+$/.test(sep);
    if (isTable) {
      flushPara();
      closeList();
      const headers = splitRow(line);
      i++; // consume the separator row
      const bodyRows = [];
      while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim()) {
        bodyRows.push(splitRow(lines[i + 1]));
        i++;
      }
      const thead = `<thead><tr>${headers
        .map((h) => `<th>${inlineMarkdown(h)}</th>`)
        .join("")}</tr></thead>`;
      const tbody = `<tbody>${bodyRows
        .map(
          (r) => `<tr>${r.map((c) => `<td>${inlineMarkdown(c)}</td>`).join("")}</tr>`,
        )
        .join("")}</tbody>`;
      html.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    closeList();
    para.push(line.trim());
  }

  if (inCode) closeCode();
  flushPara();
  closeList();
  return `<div class="markdown">${html.join("\n")}</div>`;
}

// Split a walkthrough document into renderable sections at each level-2 (`## `)
// heading. Sections whose heading starts with "Step" are flagged checkable so the
// UI can render a tick box for them; everything before the first heading (the
// title and intro) is returned as `intro`.
export function splitWalkthrough(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const preamble = [];
  const sections = [];
  let current = null;
  let inCode = false;

  for (const line of lines) {
    if (/^```/.test(line)) inCode = !inCode;
    const heading = !inCode && line.match(/^##\s+(.+)$/);
    if (heading) {
      current = { title: heading[1].trim(), lines: [line] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }

  return {
    intro: renderMarkdown(preamble.join("\n")),
    steps: sections.map((section, index) => ({
      id: index,
      title: section.title,
      checkable: /^step\b/i.test(section.title),
      html: renderMarkdown(section.lines.join("\n")),
    })),
  };
}

export function cleanTaskText(value) {
  return value
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

export function extractSectionItems(markdown, sectionName) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const items = [];
  let inSection = false;

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      const name = heading[1].replace(/\s*\(.+\)\s*$/, "").trim().toLowerCase();
      if (inSection && name !== sectionName.toLowerCase()) break;
      inSection = name === sectionName.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if (item) items.push(cleanTaskText(item[1]));
  }

  return items;
}

export function exerciseTasks(exercise) {
  const tasks = extractSectionItems(exercise.readme, "Tasks");
  return tasks.length > 0 ? tasks : extractSectionItems(exercise.readme, "Learning Objectives");
}

export function labelForPath(exercise, filePath) {
  const parts = filePath.split("/");
  const name = parts[parts.length - 1];
  const duplicate = exercise.files.filter((file) => file.path.endsWith(`/${name}`)).length > 1;
  if (!duplicate || parts.length < 2) return name;
  return `${parts[parts.length - 2]}/${name}`;
}

export function titleWithoutDuration(title) {
  return title.replace(/\s*\([^)]+\)\s*$/, "");
}
