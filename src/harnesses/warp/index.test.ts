// Guards two facts Warp enforces without telling us: a `WARP.md` beside `AGENTS.md` takes
// priority, so the block must go there when it exists; and the app's footprint is one of three
// directories depending on platform, with `~/.warp` created on demand, so detection must accept
// any of them rather than the first.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { sharedBlockFile } from "../contract.ts";
import { warp } from "./index.ts";

test("WARP.md takes the block when it exists, AGENTS.md otherwise", async () => {
  const target = warp.targets.project;
  if (target?.kind !== "shared-block") throw new Error("expected a shared block");
  await withTempDir((repo) => {
    expect(sharedBlockFile(target, repo)).toBe("AGENTS.md");
    writeFileSync(join(repo, "AGENTS.md"), "");
    expect(sharedBlockFile(target, repo)).toBe("AGENTS.md");
    writeFileSync(join(repo, "WARP.md"), "");
    expect(sharedBlockFile(target, repo)).toBe("WARP.md");
  });
});

const footprints = [
  ".warp",
  ".config/warp-terminal",
  "Library/Group Containers/2BBY89MBSN.dev.warp",
];

test.each(footprints)("Warp is detected from %s alone", async (dir) => {
  await withTempDir((home) => {
    expect(warp.detect({ home, projectRoot: null, env: {} })).toBe(false);
    mkdirSync(join(home, dir), { recursive: true });
    expect(warp.detect({ home, projectRoot: null, env: {} })).toBe(true);
  });
});
