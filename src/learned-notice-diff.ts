import { constants as fsConstants } from "node:fs";
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

/**
 * A skill path that leaves the workshop tree: a symlinked directory, a file replaced by a link,
 * or a hard link. Skill contents are sent to the model, so any such path drops the whole diff.
 */
export class UnsafeSkillPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeSkillPathError";
  }
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/**
 * The one trusted anchor for a diff: the real agent directory plus a `workshop-skills` entry
 * that is itself a real directory, not a link. Everything else is resolved beneath it and never
 * re-canonicalized, so a link swapped in later cannot become a new boundary.
 */
export async function resolveWorkshopAnchor(
  agentDir: string,
): Promise<string | undefined> {
  let agentReal: string;
  try {
    agentReal = await fs.realpath(agentDir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
  return resolveContainedDir(agentReal, [WORKSHOP_SKILLS_DIR]);
}

/**
 * Walks `segments` below `anchor` without resolving `anchor` again, refusing any component that
 * is not a real directory. `anchor` must already be a validated real path. Returns undefined
 * when a component does not exist.
 */
export async function resolveContainedDir(
  anchor: string,
  segments: readonly string[],
): Promise<string | undefined> {
  let current = anchor;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return undefined;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new UnsafeSkillPathError("skill path component is not a directory");
    }
  }
  return current;
}

/**
 * Opens without following a final symlink, then confirms through the open descriptor that the
 * file still lives under `rootReal`, which also catches a parent directory swapped for a link
 * after enumeration. Resolving the descriptor needs `/proc`; without it the read fails closed.
 */
async function readContainedFile(
  rootReal: string,
  absolute: string,
): Promise<string | undefined> {
  let handle;
  try {
    handle = await fs.open(
      absolute,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    // A file removed after the listing is simply not part of the snapshot.
    if (errnoCode(error) === "ENOENT") return undefined;
    if (errnoCode(error) === "ELOOP") {
      throw new UnsafeSkillPathError("skill file was replaced by a link");
    }
    throw error;
  }
  try {
    let opened: string;
    try {
      opened = await fs.readlink(`/proc/self/fd/${handle.fd}`);
    } catch {
      throw new UnsafeSkillPathError("cannot verify the opened skill file");
    }
    if (!isInside(rootReal, opened)) {
      throw new UnsafeSkillPathError("skill file resolves outside the skill");
    }
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    if (stat.nlink > 1) {
      throw new UnsafeSkillPathError("skill file is a hard link");
    }
    return stat.size > MAX_FILE_BYTES
      ? `[file omitted: ${stat.size} bytes]`
      : await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Regular files under `dir`, keyed by `/`-separated path; dot entries are skipped. Throws
 * {@link UnsafeSkillPathError} when `dir` or any file read from it leaves the directory.
 */
export async function readSkillFiles(dir: string): Promise<SkillFiles> {
  const files: SkillFiles = new Map();
  let dirStat;
  try {
    dirStat = await fs.lstat(dir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return files;
    throw error;
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new UnsafeSkillPathError("skill directory is not a directory");
  }
  // Callers pass a path already resolved by resolveContainedDir, so any difference means a
  // parent directory was swapped for a link after it was checked.
  const dirReal = await fs.realpath(dir);
  if (dirReal !== path.resolve(dir)) {
    throw new UnsafeSkillPathError("skill directory resolves through a link");
  }
  let entries;
  try {
    entries = await fs.readdir(dirReal, {
      recursive: true,
      withFileTypes: true,
    });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const segments = path.relative(dirReal, absolute).split(path.sep);
    if (segments.some((segment) => segment.startsWith("."))) continue;
    const content = await readContainedFile(dirReal, absolute);
    if (content !== undefined) files.set(segments.join("/"), content);
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

/**
 * Returns undefined when no trustworthy baseline exists or nothing changed. Throws
 * {@link UnsafeSkillPathError} when the live skill or its archive leaves the workshop tree.
 */
export async function loadSkillDiff(
  request: SkillDiffRequest,
): Promise<string | undefined> {
  const anchor = await resolveWorkshopAnchor(request.agentDir);
  if (!anchor) return undefined;
  const liveDir = await resolveContainedDir(anchor, [request.skillName]);
  if (!liveDir) return undefined;
  const after = await readSkillFiles(liveDir);
  if (after.size === 0) return undefined;
  let before: SkillFiles = new Map();
  if (!request.created) {
    const archivePath = [WORKSHOP_ARCHIVE_DIR, request.skillName];
    const versionsDir = await resolveContainedDir(anchor, archivePath);
    if (!versionsDir) return undefined;
    const baseline = selectBaselineVersion(
      await listArchiveVersions(versionsDir),
      request.nowMs,
    );
    if (!baseline) return undefined;
    // Resolve the baseline from the workshop anchor again, not from `versionsDir`, so a link
    // swapped in after the listing is refused instead of becoming the new root.
    const baselineDir = await resolveContainedDir(anchor, [
      ...archivePath,
      baseline.id,
    ]);
    if (!baselineDir) return undefined;
    before = await readSkillFiles(baselineDir);
  }
  return renderSkillDiff(before, after) || undefined;
}
