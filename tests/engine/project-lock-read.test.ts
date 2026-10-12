// What would drift silently: a lock path read as a shell would NOT read it. The lock says
// `./link/../x`; the kernel enters the link's target and steps out of THAT folder, so the entry
// names a folder the lexical fold never reaches, or leaves the project where the fold stays in.
import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { sourceFromLock } from "../../src/engine/project-lock-read.ts";
import type { LockSource } from "../../src/state/project-lock.ts";
import { ExitCode, MaximsError } from "../../src/util/exit-codes.ts";
import { outcome } from "../shared/outcome.ts";
import { WINDOWS } from "../shared/platform.ts";
import { withTempDir } from "../shared/temp_dir.ts";

const entry = (path: string): LockSource => ({
  from: { type: "local", path },
  select: "*",
  rule: true,
  harnesses: [],
});

// Windows folds the `..` before any entry is read, so there the lexical answer is the kernel's.
//
//   project/link    -> project/real/deep
//   project/x          the folder the fold names
//   project/real/x     the folder the kernel names
//   project/out     -> outside/deep
test.skipIf(WINDOWS)(
  "a `..` after a linked folder in a lock path steps out of the folder the link reached",
  async () => {
    await withTempDir((dir) => {
      const project = join(realpathSync(dir), "project");
      mkdirSync(join(project, "real", "deep"), { recursive: true });
      mkdirSync(join(project, "real", "x"));
      mkdirSync(join(project, "x"));
      mkdirSync(join(dir, "outside", "deep"), { recursive: true });
      symlinkSync(join(project, "real", "deep"), join(project, "link"));
      symlinkSync(join(dir, "outside", "deep"), join(project, "out"));
      expect(sourceFromLock(entry("./link/../x"), project)).toEqual({
        type: "local",
        path: join(project, "real", "x"),
      });
      const escaped = outcome(() => sourceFromLock(entry("./out/../x"), project));
      expect(escaped.kind).toBe("threw");
      if (escaped.kind !== "threw") return;
      expect(escaped.error).toBeInstanceOf(MaximsError);
      expect((escaped.error as MaximsError).code).toBe(ExitCode.Usage);
    });
  },
);
