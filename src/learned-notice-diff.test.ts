import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listArchiveVersions,
  loadSkillDiff,
  readSkillFiles,
  renderSkillDiff,
  selectBaselineVersion,
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
