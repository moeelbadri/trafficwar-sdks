import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { analyzeSources } from "./catalogAnalysis";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", "dist", "coverage", ".next", ".turbo", ".cache",
  "target", "vendor", "__pycache__", ".venv", "venv", "build", "out", ".output",
  "test", "tests", "__tests__",
]);
const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 12;
const MAX_DISPLAY_CHARS = 256;

export interface StaticCapture {
  event: string;
  label: string;
  source?: string;
  span_kind?: string;
  operation_type?: string;
  /** False when station metadata depends on runtime values. */
  station_known?: false;
  file: string;
  line: number;
}
export interface CatalogScan {
  root: string;
  captures: StaticCapture[];
  issues: CaptureIssue[];
  truncated: boolean;
}
export interface CaptureIssue {
  file: string;
  line: number;
  fields: string[];
}

export function discoverCaptures(root: string): CatalogScan {
  const resolved = path.resolve(root);
  if (!statSync(resolved).isDirectory()) throw new Error("catalog root is not a directory");
  const sources = new Map<string, string>();
  const state = { files: 0, bytes: 0, truncated: false };
  walk(resolved, 0, state, sources);
  const analysis = analyzeSources(resolved, sources);
  analysis.captures.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.event.localeCompare(b.event) || a.label.localeCompare(b.label));
  analysis.issues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { root: resolved, captures: analysis.captures, issues: analysis.issues, truncated: state.truncated || analysis.incomplete };
}

export function formatCatalogIssues(scan: CatalogScan): string {
  const lines = scan.issues.map(issue => {
    const file = JSON.stringify(issue.file).slice(1, -1);
    if (issue.fields[0] === "unparseable source") return `  ${file}:${issue.line}: source could not be parsed; check JavaScript/TypeScript syntax`;
    return `  ${file}:${issue.line}: ${issue.fields.join(" and ")} missing or not a statically resolved string`;
  });
  if (scan.truncated) lines.push("  Source scan incomplete: a limit, skipped symlink, unresolved local import, or unreadable/unparseable source was encountered.");
  if (scan.captures.length === 0) lines.push("  No fixed event/label pairs found. Check catalogRoot and include application source.");
  return [
    "[TrafficWar] capture disabled by strictCatalog; fix these issues and restart the client:",
    ...lines,
    "  Use fixed event/label fields; put request-specific values in properties or identifier fields.",
  ].join("\n");
}

export function formatCaptureCatalog(scan: CatalogScan): string {
  const root = JSON.stringify(scan.root).slice(1, -1);
  if (scan.captures.length === 0) return `[TrafficWar] no static capture() calls found under ${root}${scan.truncated ? " (scan truncated)" : ""}`;
  const lines = scan.captures.map(capture => {
    const event = JSON.stringify(clip(capture.event)).slice(1, -1);
    const label = JSON.stringify(clip(capture.label)).slice(1, -1);
    const file = JSON.stringify(capture.file).slice(1, -1);
    return `  ${event}  ${label}  ${file}:${capture.line}`;
  });
  return [`[TrafficWar] static captures (${scan.captures.length}${scan.truncated ? ", scan truncated" : ""})`, ...lines].join("\n");
}

function walk(dir: string, depth: number, state: { files: number; bytes: number; truncated: boolean }, sources: Map<string, string>): void {
  if (depth > MAX_DEPTH) { state.truncated = true; return; }
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { state.truncated = true; return; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) state.truncated = true;
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) walk(full, depth + 1, state, sources);
      continue;
    }
    if (!entry.isFile() || /\.d\.[cm]?ts$|\.(?:test|spec)\.[^.]+$/.test(entry.name) || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    if (state.files >= MAX_FILES) { state.truncated = true; return; }
    state.files++;
    try {
      const stat = statSync(full);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { state.truncated = true; continue; }
      if (state.bytes + stat.size > MAX_TOTAL_BYTES) { state.truncated = true; continue; }
      state.bytes += stat.size;
      sources.set(full, readFileSync(full, "utf8"));
    } catch { state.truncated = true; }
  }
}

function clip(value: string): string {
  return value.length <= MAX_DISPLAY_CHARS ? value : `${value.slice(0, MAX_DISPLAY_CHARS - 3)}...`;
}
