// Fails if the container copy starts carrying the host's token file, agent worktrees, git
// history, dependencies, or build output into the work tree, if the dependency link moves, or if
// a file the copy cannot read stops being a failure that leaves the work tree empty.
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WINDOWS } from "../shared/platform.ts";
import { REPO_ROOT } from "./runner.ts";

const ENTRYPOINT = join(REPO_ROOT, "tests", "container", "entrypoint.sh");
const HOST_FILES = [".env", ".claude/x", ".git/HEAD", "node_modules/x", "dist/x", "src/y"];
const HANDOFF = "handed-off\n";

type Entry =
  | { path: string; kind: "file" }
  | { path: string; kind: "dir" }
  | { path: string; kind: "symlink"; target: string };

type Outcome = { ok: boolean; stdout: string; work: Entry[] };

function walk(dir: string, prefix = ""): Entry[] {
  const entries: Entry[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const relative = prefix === "" ? name : `${prefix}/${name}`;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      entries.push({ path: relative, kind: "symlink", target: readlinkSync(path) });
    } else if (stat.isDirectory()) {
      entries.push({ path: relative, kind: "dir" }, ...walk(path, relative));
    } else {
      entries.push({ path: relative, kind: "file" });
    }
  }
  return entries;
}

// TMPDIR points into the fixture so the archive a failed copy leaves behind goes with it.
function runCopy(arrange: (repo: string) => void): Outcome {
  const root = mkdtempSync(join(tmpdir(), "maxims-entrypoint-"));
  const repo = join(root, "repo");
  const work = join(root, "work");
  const temp = join(root, "tmp");
  try {
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
    return { ok: proc.exitCode === 0, stdout: proc.stdout.toString(), work: walk(work) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The entrypoint is a POSIX sh script run on the host; Git Bash's ln -s copies instead of linking.
describe.skipIf(WINDOWS)("the entrypoint's copy from the mounted checkout", () => {
  test("carries only the source tree and links the image's dependencies", () => {
    expect(runCopy(() => {})).toEqual({
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
  test.skipIf(process.getuid?.() === 0)("stops before the handoff on an unreadable file", () => {
    const outcome = runCopy((repo) => {
      writeFileSync(join(repo, "src", "secret"), "token\n");
      chmodSync(join(repo, "src", "secret"), 0o000);
    });
    expect(outcome).toEqual({ ok: false, stdout: "", work: [] });
  });
});
