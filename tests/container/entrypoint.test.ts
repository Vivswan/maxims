// Fails if the container copy starts carrying the host's token file, agent worktrees, git
// history, dependencies, or build output into the work tree, if the dependency link moves, or if
// a file the copy cannot read stops being a failure that leaves the work tree empty.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WINDOWS } from "../shared/platform.ts";
import { withTempDir } from "../shared/temp_dir.ts";
import { type TreeEntry, walkTree } from "../shared/tree.ts";
import { REPO_ROOT } from "./runner.ts";

const ENTRYPOINT = join(REPO_ROOT, "tests", "container", "entrypoint.sh");
const HOST_FILES = [".env", ".claude/x", ".git/HEAD", "node_modules/x", "dist/x", "src/y"];
const HANDOFF = "handed-off\n";

type Outcome = { ok: boolean; stdout: string; work: TreeEntry[] };

// TMPDIR points into the fixture so the archive a failed copy leaves behind goes with it.
function runCopy(arrange: (repo: string) => void): Promise<Outcome> {
  return withTempDir((root) => {
    const repo = join(root, "repo");
    const work = join(root, "work");
    const temp = join(root, "tmp");
    for (const dir of [repo, work, temp]) mkdirSync(dir);
    for (const file of HOST_FILES) {
      mkdirSync(join(repo, dirname(file)), { recursive: true });
      writeFileSync(join(repo, file), `${file}\n`);
    }
    arrange(repo);
    const proc = Bun.spawnSync(["sh", ENTRYPOINT, "echo", "handed-off"], {
      env: {
        PATH: process.env.PATH ?? "",
        ENTRYPOINT_REPO: repo,
        ENTRYPOINT_WORK: work,
        TMPDIR: temp,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { ok: proc.exitCode === 0, stdout: proc.stdout.toString(), work: walkTree(work) };
  });
}

// The entrypoint is a POSIX sh script run on the host; Git Bash's ln -s copies instead of linking.
describe.skipIf(WINDOWS)("the entrypoint's copy from the mounted checkout", () => {
  test("carries only the source tree and links the image's dependencies", async () => {
    expect(await runCopy(() => {})).toEqual({
      ok: true,
      stdout: HANDOFF,
      work: [
        { path: "node_modules", kind: "symlink", target: "/deps/node_modules" },
        { path: "src", kind: "dir" },
        { path: "src/y", kind: "file" },
      ],
    });
  });

  // Root reads a 0000 file through CAP_DAC_OVERRIDE, so this scene only proves anything for an
  // unprivileged suite. The file carries bytes because bsdtar never opens a zero-length entry.
  test.skipIf(process.getuid?.() === 0)(
    "stops before the handoff on an unreadable file",
    async () => {
      const outcome = await runCopy((repo) => {
        writeFileSync(join(repo, "src", "secret"), "token\n");
        chmodSync(join(repo, "src", "secret"), 0o000);
      });
      expect(outcome).toEqual({ ok: false, stdout: "", work: [] });
    },
  );
});
