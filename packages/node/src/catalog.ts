import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "build",
  "out",
  ".output",
]);

const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_DEPTH = 12;
const MAX_LITERAL_CHARS = 256;

const REGEX_BEFORE = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "~",
  "*",
  "^",
  "%",
  ">",
  "<",
]);

const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "throw",
  "void",
  "delete",
  "await",
  "yield",
  "else",
  "do",
  "in",
  "of",
]);

export interface StaticCapture {
  event: string;
  label: string;
  file: string;
  line: number;
}

export interface CatalogScan {
  root: string;
  captures: StaticCapture[];
  truncated: boolean;
}

interface RawCapture {
  event: string;
  label: string;
  line: number;
}

export function discoverCaptures(root: string): CatalogScan {
  const resolved = path.resolve(root);
  const rootStat = statSync(resolved);
  if (!rootStat.isDirectory()) {
    throw new Error("catalog root is not a directory");
  }

  const found: StaticCapture[] = [];
  const state = { files: 0, truncated: false };
  walk(resolved, resolved, 0, state, found);
  found.sort((left, right) => {
    return (
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.event.localeCompare(right.event) ||
      left.label.localeCompare(right.label)
    );
  });
  return { root: resolved, captures: found, truncated: state.truncated };
}

export function formatCaptureCatalog(scan: CatalogScan): string {
  if (scan.captures.length === 0) {
    const suffix = scan.truncated ? " (scan truncated)" : "";
    return `[TrafficWar] no static capture() calls found under ${scan.root}${suffix}`;
  }
  const suffix = scan.truncated ? ", scan truncated" : "";
  const lines = scan.captures.map((capture) => {
    return `  ${capture.event}  ${capture.label}  ${capture.file}:${capture.line}`;
  });
  return [
    `[TrafficWar] static captures (${scan.captures.length}${suffix})`,
    ...lines,
  ].join("\n");
}

function walk(
  root: string,
  dir: string,
  depth: number,
  state: { files: number; truncated: boolean },
  found: StaticCapture[],
): void {
  if (state.truncated) {
    return;
  }
  if (depth > MAX_DEPTH) {
    state.truncated = true;
    return;
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (state.truncated) {
      return;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        walk(root, full, depth + 1, state, found);
      }
      continue;
    }
    if (!entry.isFile() || !isSourceFile(entry.name)) {
      continue;
    }
    if (state.files >= MAX_FILES) {
      state.truncated = true;
      return;
    }
    state.files += 1;

    let source: string;
    try {
      const fileStat = statSync(full);
      if (!fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) {
        continue;
      }
      source = readFileSync(full, "utf8");
    } catch {
      continue;
    }

    try {
      for (const capture of scanSource(source)) {
        found.push({
          event: clip(capture.event),
          label: clip(capture.label),
          file: path.relative(root, full).split(path.sep).join("/"),
          line: capture.line,
        });
      }
    } catch {
      // One unreadable syntax shape must not hide the rest of the catalog.
    }
  }
}

function isSourceFile(name: string): boolean {
  if (name.endsWith(".d.ts")) {
    return false;
  }
  return SOURCE_EXTENSIONS.has(path.extname(name));
}

function clip(value: string): string {
  if (
    value === "<dynamic>" ||
    value === "<missing>" ||
    value.length <= MAX_LITERAL_CHARS
  ) {
    return value;
  }
  return `${value.slice(0, MAX_LITERAL_CHARS - 3)}...`;
}

function scanSource(source: string): RawCapture[] {
  const captures: RawCapture[] = [];
  const limit = source.length;
  let index = 0;
  while (index < limit) {
    index = skipTrivia(source, index, limit);
    if (index >= limit) {
      break;
    }
    if (source[index] === "/" && looksLikeRegex(source, index)) {
      index = skipRegex(source, index, limit);
      continue;
    }
    if (source[index] === "`") {
      index = skipTemplate(source, index, limit);
      continue;
    }
    if (source[index] === "'" || source[index] === '"') {
      index = skipQuoted(source, index, limit);
      continue;
    }
    if (isIdentStart(source[index]!)) {
      const identEnd = readIdentEnd(source, index, limit);
      const ident = source.slice(index, identEnd);
      if (ident === "capture") {
        const after = skipTrivia(source, identEnd, limit);
        if (source[after] === "(") {
          const close = matchingDelimiter(source, after, limit, "(", ")");
          if (close !== -1) {
            captures.push(
              ...extractArgument(source, after + 1, close),
            );
            index = close + 1;
            continue;
          }
        }
      }
      index = identEnd;
      continue;
    }
    index += 1;
  }
  return captures;
}

function extractArgument(
  source: string,
  start: number,
  end: number,
): RawCapture[] {
  const index = skipTrivia(source, start, end);
  if (index >= end) {
    return [];
  }
  if (source[index] === "{") {
    const parsed = parseObject(source, index, end);
    return parsed.row === undefined ? [] : [parsed.row];
  }
  if (source[index] === "[") {
    return parseArray(source, index, end);
  }
  return [];
}

function parseArray(
  source: string,
  open: number,
  limit: number,
): RawCapture[] {
  const rows: RawCapture[] = [];
  let index = open + 1;
  while (index < limit) {
    index = skipTrivia(source, index, limit);
    if (index >= limit || source[index] === "]") {
      break;
    }
    if (source[index] === ",") {
      index += 1;
      continue;
    }
    if (source[index] === "{") {
      const parsed = parseObject(source, index, limit);
      if (parsed.row !== undefined) {
        rows.push(parsed.row);
      }
      index = parsed.next;
      continue;
    }
    index = skipExpression(source, index, limit);
  }
  return rows;
}

function parseObject(
  source: string,
  open: number,
  limit: number,
): { row: RawCapture | undefined; next: number } {
  const line = lineAt(source, open);
  let event: string | undefined;
  let label: string | undefined;
  let saw = false;
  let index = open + 1;

  while (index < limit) {
    index = skipTrivia(source, index, limit);
    if (index >= limit) {
      break;
    }
    if (source[index] === "}") {
      return {
        row: saw ? finishRow(event, label, line) : undefined,
        next: index + 1,
      };
    }
    if (source[index] === ",") {
      index += 1;
      continue;
    }
    if (source.startsWith("...", index)) {
      index = skipExpression(source, index + 3, limit);
      continue;
    }

    const key = readKey(source, index, limit);
    if (key === undefined) {
      index = skipExpression(source, index, limit);
      continue;
    }
    index = skipTrivia(source, key.next, limit);
    if (source[index] !== ":") {
      if (key.name === "event" || key.name === "label") {
        saw = true;
        if (key.name === "event") {
          event = "<dynamic>";
        } else {
          label = "<dynamic>";
        }
      }
      continue;
    }

    const value = readValue(source, index + 1, limit);
    if (key.name === "event" || key.name === "label") {
      saw = true;
      const text = value.literal ?? "<dynamic>";
      if (key.name === "event") {
        event = text;
      } else {
        label = text;
      }
    }
    index = value.next;
  }

  return {
    row: saw ? finishRow(event, label, line) : undefined,
    next: index,
  };
}

function finishRow(
  event: string | undefined,
  label: string | undefined,
  line: number,
): RawCapture {
  return {
    event: event ?? "<missing>",
    label: label ?? "<missing>",
    line,
  };
}

function readKey(
  source: string,
  start: number,
  limit: number,
): { name: string; next: number } | undefined {
  const index = skipTrivia(source, start, limit);
  if (index >= limit) {
    return undefined;
  }
  if (isIdentStart(source[index]!)) {
    const end = readIdentEnd(source, index, limit);
    return { name: source.slice(index, end), next: end };
  }
  const quoted = tryReadString(source, index, limit);
  if (quoted?.complete === true && !quoted.template) {
    return { name: quoted.value, next: quoted.next };
  }
  if (source[index] === "[") {
    const inner = skipTrivia(source, index + 1, limit);
    const computed = tryReadString(source, inner, limit);
    if (computed?.complete === true && !computed.template) {
      const after = skipTrivia(source, computed.next, limit);
      if (source[after] === "]") {
        return { name: computed.value, next: after + 1 };
      }
    }
  }
  return undefined;
}

function readValue(
  source: string,
  start: number,
  limit: number,
): { literal: string | null; next: number } {
  const index = skipTrivia(source, start, limit);
  const quoted = tryReadString(source, index, limit);
  if (quoted?.complete === true) {
    const after = skipTrivia(source, quoted.next, limit);
    if (
      source.startsWith("as ", after) ||
      source.startsWith("satisfies ", after)
    ) {
      return {
        literal: quoted.value,
        next: skipExpression(source, after, limit),
      };
    }
    if (
      after >= limit ||
      source[after] === "," ||
      source[after] === "}" ||
      source[after] === "]"
    ) {
      return { literal: quoted.value, next: quoted.next };
    }
  }
  return { literal: null, next: skipExpression(source, index, limit) };
}

function skipExpression(source: string, start: number, limit: number): number {
  let index = start;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  while (index < limit) {
    const trivia = skipTrivia(source, index, limit);
    if (trivia !== index) {
      index = trivia;
      continue;
    }
    if (index >= limit) {
      break;
    }
    if (source[index] === "/" && looksLikeRegex(source, index)) {
      index = skipRegex(source, index, limit);
      continue;
    }
    if (source[index] === "`") {
      index = skipTemplate(source, index, limit);
      continue;
    }
    if (source[index] === "'" || source[index] === '"') {
      index = skipQuoted(source, index, limit);
      continue;
    }
    const char = source[index]!;
    if (
      paren === 0 &&
      brace === 0 &&
      bracket === 0 &&
      (char === "," || char === "}" || char === "]")
    ) {
      return index;
    }
    if (char === "(") {
      paren += 1;
    } else if (char === ")") {
      if (paren === 0) {
        return index;
      }
      paren -= 1;
    } else if (char === "{") {
      brace += 1;
    } else if (char === "}") {
      if (brace === 0) {
        return index;
      }
      brace -= 1;
    } else if (char === "[") {
      bracket += 1;
    } else if (char === "]") {
      if (bracket === 0) {
        return index;
      }
      bracket -= 1;
    }
    index += 1;
  }
  return index;
}

function skipTrivia(source: string, start: number, limit: number): number {
  let index = start;
  while (index < limit) {
    const char = source[index]!;
    if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f") {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < limit && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < limit && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index = Math.min(limit, index + 2);
      continue;
    }
    break;
  }
  return index;
}

function skipQuoted(source: string, start: number, limit: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < limit) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) {
      return index + 1;
    }
    if (source[index] === "\n" || source[index] === "\r") {
      return index;
    }
    index += 1;
  }
  return limit;
}

function skipTemplate(source: string, start: number, limit: number): number {
  let index = start + 1;
  while (index < limit) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "`") {
      return index + 1;
    }
    if (source[index] === "$" && source[index + 1] === "{") {
      const close = matchingDelimiter(source, index + 1, limit, "{", "}");
      index = close === -1 ? limit : close + 1;
      continue;
    }
    index += 1;
  }
  return limit;
}

function tryReadString(
  source: string,
  start: number,
  limit: number,
): { value: string; next: number; complete: boolean; template: boolean } | undefined {
  const quote = source[start];
  if (quote !== "'" && quote !== '"' && quote !== "`") {
    return undefined;
  }
  let index = start + 1;
  let value = "";
  let complete = true;
  while (index < limit) {
    const char = source[index]!;
    if (char === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined) {
        complete = false;
        break;
      }
      value += unescape(escaped);
      index += 2;
      continue;
    }
    if (quote === "`" && char === "$" && source[index + 1] === "{") {
      return { value: "", next: start, complete: false, template: true };
    }
    if (char === quote) {
      return { value, next: index + 1, complete, template: quote === "`" };
    }
    if ((quote === "'" || quote === '"') && (char === "\n" || char === "\r")) {
      complete = false;
      break;
    }
    value += char;
    index += 1;
  }
  return { value, next: limit, complete: false, template: quote === "`" };
}

function unescape(char: string): string {
  switch (char) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case "\\":
    case "'":
    case '"':
    case "`":
      return char;
    default:
      return char;
  }
}

function looksLikeRegex(source: string, index: number): boolean {
  if (source[index] !== "/" || source[index + 1] === "/" || source[index + 1] === "*") {
    return false;
  }
  let previous = index - 1;
  while (previous >= 0 && /\s/.test(source[previous]!)) {
    previous -= 1;
  }
  if (previous < 0) {
    return true;
  }
  if (source[previous] === "*" && source[previous - 1] === "/") {
    return true;
  }
  const char = source[previous]!;
  if (REGEX_BEFORE.has(char)) {
    return true;
  }
  if (isIdentChar(char)) {
    const end = previous + 1;
    let start = previous;
    while (start > 0 && isIdentChar(source[start - 1]!)) {
      start -= 1;
    }
    return REGEX_KEYWORDS.has(source.slice(start, end));
  }
  return false;
}

function skipRegex(source: string, start: number, limit: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < limit) {
    const char = source[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[" && !inClass) {
      inClass = true;
    } else if (char === "]" && inClass) {
      inClass = false;
    } else if (char === "/" && !inClass) {
      index += 1;
      while (index < limit && /[a-z]/i.test(source[index]!)) {
        index += 1;
      }
      return index;
    } else if (char === "\n") {
      return start + 1;
    }
    index += 1;
  }
  return limit;
}

function matchingDelimiter(
  source: string,
  openIndex: number,
  limit: number,
  open: string,
  close: string,
): number {
  let depth = 1;
  let index = openIndex + 1;
  while (index < limit) {
    const trivia = skipTrivia(source, index, limit);
    if (trivia !== index) {
      index = trivia;
      continue;
    }
    if (source[index] === "/" && looksLikeRegex(source, index)) {
      index = skipRegex(source, index, limit);
      continue;
    }
    if (source[index] === "`") {
      index = skipTemplate(source, index, limit);
      continue;
    }
    if (source[index] === "'" || source[index] === '"') {
      index = skipQuoted(source, index, limit);
      continue;
    }
    if (source[index] === open) {
      depth += 1;
    } else if (source[index] === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
    index += 1;
  }
  return -1;
}

function isIdentStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char);
}

function isIdentChar(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function readIdentEnd(source: string, start: number, limit: number): number {
  let index = start + 1;
  while (index < limit && isIdentChar(source[index]!)) {
    index += 1;
  }
  return index;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  const stop = Math.min(index, source.length);
  for (let cursor = 0; cursor < stop; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }
  return line;
}
