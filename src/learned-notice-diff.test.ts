import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listArchiveVersions,
  loadSkillDiff,
  readSkillFiles,
  renderSkillDiff,
  selectBaselineVersion,
  UnsafeSkillPathError,
} from "./learned-notice-diff.js";

const MINUTE = 60_000;
const at = (iso: string) => Date.parse(iso);
const versionId = (iso: string, action = "patch") =>
  `${new Date(iso).toISOString().replace(/[-:.]/g, "")}-${action}`;

describe("selectBaselineVersion", () => {
  const now = at("2026-10-20T12:00:00.000Z");
  const v = (iso: string) => ({ id: versionId(iso), createdAtMs: at(iso) });

  it("uses the newest version when it stands alone", () => {
    const versions = [
      v("2026-10-20T11:59:00.000Z"),
      v("2026-10-19T08:00:00.000Z"),
    ];
    expect(selectBaselineVersion(versions, now)).toEqual(versions[0]);
  });

  it("walks back through a burst of close versions", () => {
    const versions = [
      v("2026-10-20T11:59:30.000Z"),
      v("2026-10-20T11:59:10.000Z"),
      v("2026-10-20T11:58:50.000Z"),
      v("2026-10-20T09:00:00.000Z"),
    ];
    expect(selectBaselineVersion(versions, now)).toEqual(versions[2]);
  });

  it("rejects a newest version older than the max age", () => {
    expect(
      selectBaselineVersion(
        [v("2026-10-20T10:00:00.000Z")],
        now,
        10 * MINUTE,
        60 * MINUTE,
      ),
    ).toBeUndefined();
    expect(selectBaselineVersion([], now)).toBeUndefined();
  });
});

describe("renderSkillDiff", () => {
  it("shows changed lines with context and skips unchanged files", () => {
    const before = new Map([
      ["SKILL.md", "a\nb\nc\nd\ne\nf\ng\n"],
      ["references/same.md", "same\n"],
      ["references/gone.md", "old\n"],
    ]);
    const after = new Map([
      ["SKILL.md", "a\nb\nc\nD\ne\nf\ng\n"],
      ["references/same.md", "same\n"],
      ["references/new.md", "fresh\n"],
    ]);
    expect(renderSkillDiff(before, after)).toBe(
      [
        "*** SKILL.md\n b\n c\n-d\n+D\n e\n f",
        "--- references/gone.md (deleted)\n-old",
        "+++ references/new.md (new file)\n+fresh",
      ].join("\n\n"),
    );
  });

  it("separates distant hunks", () => {
    const before = new Map([["SKILL.md", "1\n2\n3\n4\n5\n6\n7\n8\n9\n"]]);
    const after = new Map([["SKILL.md", "x\n2\n3\n4\n5\n6\n7\n8\ny\n"]]);
    expect(renderSkillDiff(before, after)).toBe(
      "*** SKILL.md\n-1\n+x\n 2\n 3\n…\n 7\n 8\n-9\n+y",
    );
  });

  it("returns an empty string when nothing changed", () => {
    const files = new Map([["SKILL.md", "x\n"]]);
    expect(renderSkillDiff(files, new Map(files))).toBe("");
  });
});

describe("skill files on disk", () => {
  let agentDir: string;
  const now = at("2026-10-20T12:00:00.000Z");

  async function write(relative: string, content: string) {
    const target = path.join(agentDir, "workshop-skills", relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  beforeEach(async () => {
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "learned-notice-"));
  });

  afterEach(async () => {
    await fs.rm(agentDir, { recursive: true, force: true });
  });

  it("lists version directories newest first and ignores other entries", async () => {
    const older = versionId("2026-10-20T11:00:00.000Z");
    const newer = versionId("2026-10-20T11:30:00.000Z", "write_file");
    await write(`.archive/alpha/${older}/SKILL.md`, "x");
    await write(`.archive/alpha/${newer}/SKILL.md`, "x");
    await write(".archive/alpha/.snapshot-tmp/SKILL.md", "x");
    await write(".archive/alpha/notes.txt", "x");
    const versions = await listArchiveVersions(
      path.join(agentDir, "workshop-skills", ".archive", "alpha"),
    );
    expect(versions.map((version) => version.id)).toEqual([newer, older]);
    expect(await listArchiveVersions(path.join(agentDir, "missing"))).toEqual(
      [],
    );
  });

  it("reads regular files and skips dot entries", async () => {
    await write("alpha/SKILL.md", "body\n");
    await write("alpha/references/a.md", "ref\n");
    await write("alpha/.hidden/x.md", "secret\n");
    const files = await readSkillFiles(
      path.join(agentDir, "workshop-skills", "alpha"),
    );
    expect([...files.keys()].sort()).toEqual(["SKILL.md", "references/a.md"]);
  });

  it("skips a file removed after the directory listing", async () => {
    await write("alpha/SKILL.md", "body\n");
    await write("alpha/references/gone.md", "temp\n");
    const realOpen = fs.open;
    const open = vi
      .spyOn(fs, "open")
      .mockImplementation(async (target, ...rest) => {
        if (String(target).endsWith("gone.md")) {
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        }
        return realOpen(target, ...rest);
      });
    try {
      const files = await readSkillFiles(
        path.join(agentDir, "workshop-skills", "alpha"),
      );
      expect([...files.keys()]).toEqual(["SKILL.md"]);
    } finally {
      open.mockRestore();
    }
  });

  it("still fails on other read errors", async () => {
    await write("alpha/SKILL.md", "body\n");
    const open = vi
      .spyOn(fs, "open")
      .mockRejectedValue(
        Object.assign(new Error("denied"), { code: "EACCES" }),
      );
    try {
      await expect(
        readSkillFiles(path.join(agentDir, "workshop-skills", "alpha")),
      ).rejects.toThrow("denied");
    } finally {
      open.mockRestore();
    }
  });

  it("diffs an updated skill against the burst baseline", async () => {
    await write("alpha/SKILL.md", "step 1\nstep 2 checked\nstep 3\n");
    await write(
      `.archive/alpha/${versionId("2026-10-20T11:59:00.000Z")}/SKILL.md`,
      "step 1\nstep 2 middle\nstep 3\n",
    );
    await write(
      `.archive/alpha/${versionId("2026-10-20T11:58:55.000Z")}/SKILL.md`,
      "step 1\nstep 2\nstep 3\n",
    );
    expect(
      await loadSkillDiff({
        agentDir,
        skillName: "alpha",
        created: false,
        nowMs: now,
      }),
    ).toBe("*** SKILL.md\n step 1\n-step 2\n+step 2 checked\n step 3");
  });

  it("treats a created skill's whole tree as the change", async () => {
    await write("alpha/SKILL.md", "hello\n");
    expect(
      await loadSkillDiff({
        agentDir,
        skillName: "alpha",
        created: true,
        nowMs: now,
      }),
    ).toBe("+++ SKILL.md (new file)\n+hello");
  });

  it("returns undefined without a live skill or a recent baseline", async () => {
    expect(
      await loadSkillDiff({
        agentDir,
        skillName: "alpha",
        created: false,
        nowMs: now,
      }),
    ).toBeUndefined();
    await write("alpha/SKILL.md", "hello\n");
    await write(
      `.archive/alpha/${versionId("2026-10-19T08:00:00.000Z")}/SKILL.md`,
      "old\n",
    );
    expect(
      await loadSkillDiff({
        agentDir,
        skillName: "alpha",
        created: false,
        nowMs: now,
      }),
    ).toBeUndefined();
  });
});

describe("workshop containment", () => {
  let agentDir: string;
  let outside: string;
  const now = at("2026-10-20T12:00:00.000Z");
  const skillsRoot = () => path.join(agentDir, "workshop-skills");

  async function write(target: string, content: string) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  beforeEach(async () => {
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "learned-contain-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "learned-outside-"));
    await write(path.join(outside, "private-marker.txt"), "secret\n");
    await write(path.join(outside, "references", "a.md"), "secret ref\n");
    await fs.mkdir(skillsRoot(), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("rejects a symlinked live skill root", async () => {
    await fs.symlink(outside, path.join(skillsRoot(), "alpha"));
    await expect(
      loadSkillDiff({
        agentDir,
        skillName: "alpha",
        created: true,
        nowMs: now,
      }),
    ).rejects.toBeInstanceOf(UnsafeSkillPathError);
  });

  it("rejects a symlinked archive ancestor", async () => {
    await write(path.join(skillsRoot(), "alpha", "SKILL.md"), "live\n");
    await write(
      path.join(
        outside,
        "archive",
        "alpha",
        versionId("2026-10-20T11:59:00.000Z"),
        "SKILL.md",
      ),
      "secret archive\n",
    );
    await fs.symlink(
      path.join(outside, "archive"),
      path.join(skillsRoot(), ".archive"),
    );
    await expect(
      loadSkillDiff({
        agentDir,
        skillName: "alpha",
        created: false,
        nowMs: now,
      }),
    ).rejects.toBeInstanceOf(UnsafeSkillPathError);
  });

  it("rejects a file replaced by a symlink after enumeration", async () => {
    const dir = path.join(skillsRoot(), "alpha");
    await write(path.join(dir, "SKILL.md"), "live\n");
    const realReaddir = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args: unknown[]) => {
      const entries = await (realReaddir as (...a: unknown[]) => unknown)(
        ...args,
      );
      await fs.rm(path.join(dir, "SKILL.md"));
      await fs.symlink(
        path.join(outside, "private-marker.txt"),
        path.join(dir, "SKILL.md"),
      );
      return entries as never;
    });
    await expect(readSkillFiles(dir)).rejects.toBeInstanceOf(
      UnsafeSkillPathError,
    );
  });

  it("rejects a parent directory swapped for a symlink after enumeration", async () => {
    const dir = path.join(skillsRoot(), "alpha");
    await write(path.join(dir, "references", "a.md"), "live ref\n");
    const realReaddir = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args: unknown[]) => {
      const entries = await (realReaddir as (...a: unknown[]) => unknown)(
        ...args,
      );
      await fs.rm(path.join(dir, "references"), { recursive: true });
      await fs.symlink(
        path.join(outside, "references"),
        path.join(dir, "references"),
      );
      return entries as never;
    });
    await expect(readSkillFiles(dir)).rejects.toBeInstanceOf(
      UnsafeSkillPathError,
    );
  });

  it("rejects a hard link to a file outside the skill", async () => {
    const dir = path.join(skillsRoot(), "alpha");
    await fs.mkdir(dir, { recursive: true });
    await fs.link(
      path.join(outside, "private-marker.txt"),
      path.join(dir, "SKILL.md"),
    );
    await expect(readSkillFiles(dir)).rejects.toBeInstanceOf(
      UnsafeSkillPathError,
    );
  });

  it("rejects a directory reached through a symlinked parent", async () => {
    await fs.symlink(outside, path.join(skillsRoot(), "linked"));
    await expect(
      readSkillFiles(path.join(skillsRoot(), "linked", "references")),
    ).rejects.toBeInstanceOf(UnsafeSkillPathError);
  });
});
