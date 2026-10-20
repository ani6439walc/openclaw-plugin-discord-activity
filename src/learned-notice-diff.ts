import fs from "node:fs/promises";
import path from "node:path";

/**
 * Reads a learned skill and the archived version it most likely replaced, and renders a
 * bounded line diff for the notice summary.
 *
 * Workshop layout (OpenClaw 2026.10.5): live skills live in `<agentDir>/workshop-skills/<name>/`
 * and every edit first copies the live tree to `<agentDir>/workshop-skills/.archive/<name>/<versionId>/`,
 * where `versionId` is `<UTC timestamp>-<action>`. The notice does not carry the version a review
 * started from, so the baseline is a heuristic: the newest version, extended back through versions
 * written close together, because one review writes its edits within seconds of each other.
 */

export const WORKSHOP_SKILLS_DIR = "workshop-skills";
export const WORKSHOP_ARCHIVE_DIR = ".archive";

const VERSION_ID_PATTERN =
  /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-(create|patch|write_file|remove_file|archive|restore)$/;

export const DEFAULT_BASELINE_GAP_MS = 10 * 60_000;
export const DEFAULT_BASELINE_MAX_AGE_MS = 60 * 60_000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_DIFF_CELLS = 1_000_000;
const CONTEXT_LINES = 2;

export type ArchiveVersion = { id: string; createdAtMs: number };

export type SkillFiles = Map<string, string>;

/** Newest first; entries that are not version directories are ignored. */
export async function listArchiveVersions(
  versionsDir: string,
): Promise<ArchiveVersion[]> {
  let entries;
  try {
    entries = await fs.readdir(versionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const versions: ArchiveVersion[] = [];
  for (const entry of entries) {
    const match = VERSION_ID_PATTERN.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const [, year, month, day, hour, minute, second, ms] = match;
    versions.push({
      id: entry.name,
      createdAtMs: Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        Number(ms),
      ),
    });
  }
  return versions.sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * Picks the version the latest burst of edits started from. Returns undefined when the newest
 * version is older than `maxAgeMs`, since it then cannot belong to the review being announced.
 */
export function selectBaselineVersion(
  versions: readonly ArchiveVersion[],
  nowMs: number,
  gapMs = DEFAULT_BASELINE_GAP_MS,
  maxAgeMs = DEFAULT_BASELINE_MAX_AGE_MS,
): ArchiveVersion | undefined {
  let baseline = versions[0];
  if (!baseline || nowMs - baseline.createdAtMs > maxAgeMs) return undefined;
  for (const older of versions.slice(1)) {
    if (baseline.createdAtMs - older.createdAtMs > gapMs) break;
    baseline = older;
  }
  return baseline;
}

/** Regular files under `dir`, keyed by `/`-separated path; dot entries and links are skipped. */
export async function readSkillFiles(dir: string): Promise<SkillFiles> {
  const files: SkillFiles = new Map();
  let entries;
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const segments = path.relative(dir, absolute).split(path.sep);
    if (segments.some((segment) => segment.startsWith("."))) continue;
    const stat = await fs.stat(absolute);
    files.set(
      segments.join("/"),
      stat.size > MAX_FILE_BYTES
        ? `[file omitted: ${stat.size} bytes]`
        : await fs.readFile(absolute, "utf8"),
    );
  }
  return files;
}

type DiffOp = { kind: " " | "-" | "+"; line: string };

function diffLines(before: string[], after: string[]): DiffOp[] {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  const head = before
    .slice(0, prefix)
    .map((line): DiffOp => ({ kind: " ", line }));
  const tail = before
    .slice(before.length - suffix)
    .map((line): DiffOp => ({ kind: " ", line }));

  if ((a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS) {
    return [
      ...head,
      ...a.map((line): DiffOp => ({ kind: "-", line })),
      ...b.map((line): DiffOp => ({ kind: "+", line })),
      ...tail,
    ];
  }

  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const middle: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      middle.push({ kind: " ", line: a[i]! });
      i++;
      j++;
    } else if (
      i < a.length &&
      (j === b.length || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)
    ) {
      middle.push({ kind: "-", line: a[i]! });
      i++;
    } else {
      middle.push({ kind: "+", line: b[j]! });
      j++;
    }
  }
  return [...head, ...middle, ...tail];
}

function renderHunks(ops: readonly DiffOp[]): string {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === " ") return;
    for (
      let k = Math.max(0, index - CONTEXT_LINES);
      k <= Math.min(ops.length - 1, index + CONTEXT_LINES);
      k++
    ) {
      keep[k] = true;
    }
  });
  const lines: string[] = [];
  let skipped = false;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      skipped = true;
      return;
    }
    if (skipped && lines.length > 0) lines.push("…");
    skipped = false;
    lines.push(`${op.kind}${op.line}`);
  });
  return lines.join("\n");
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
}

/** Per-file unified-style diff; unchanged files are omitted. Empty when nothing differs. */
export function renderSkillDiff(before: SkillFiles, after: SkillFiles): string {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(
    (x, y) =>
      x === "SKILL.md" ? -1 : y === "SKILL.md" ? 1 : x.localeCompare(y),
  );
  const sections: string[] = [];
  for (const filePath of paths) {
    const oldText = before.get(filePath);
    const newText = after.get(filePath);
    if (oldText === newText) continue;
    const label =
      oldText === undefined
        ? `+++ ${filePath} (new file)`
        : newText === undefined
          ? `--- ${filePath} (deleted)`
          : `*** ${filePath}`;
    const ops = diffLines(splitLines(oldText ?? ""), splitLines(newText ?? ""));
    sections.push(`${label}\n${renderHunks(ops)}`);
  }
  return sections.join("\n\n");
}

export type SkillDiffRequest = {
  agentDir: string;
  skillName: string;
  /** A created skill has no baseline; its whole tree is the change. */
  created: boolean;
  nowMs: number;
};

/** Returns undefined when no trustworthy baseline exists or nothing changed. */
export async function loadSkillDiff(
  request: SkillDiffRequest,
): Promise<string | undefined> {
  const skillsRoot = path.join(request.agentDir, WORKSHOP_SKILLS_DIR);
  const after = await readSkillFiles(path.join(skillsRoot, request.skillName));
  if (after.size === 0) return undefined;
  let before: SkillFiles = new Map();
  if (!request.created) {
    const versionsDir = path.join(
      skillsRoot,
      WORKSHOP_ARCHIVE_DIR,
      request.skillName,
    );
    const baseline = selectBaselineVersion(
      await listArchiveVersions(versionsDir),
      request.nowMs,
    );
    if (!baseline) return undefined;
    before = await readSkillFiles(path.join(versionsDir, baseline.id));
  }
  return renderSkillDiff(before, after) || undefined;
}
