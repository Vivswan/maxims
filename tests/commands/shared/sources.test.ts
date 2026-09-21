// What would drift silently: a local source whose real path the state schema refuses (a NUL, a
// line break, an edge space, a `-->`) recorded anyway, so the next read quarantines the state
// file; the refusal must name the state schema's reason and fall on the REAL path, since a symlink
// spelled with one of those shapes may point at a directory the schema accepts.
import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { realLocal } from "../../../src/commands/shared/sources.ts";
import { ExitCode, MaximsError } from "../../../src/util/exit-codes.ts";
import { WINDOWS } from "../../shared/platform.ts";
import { withTempDir } from "../../shared/temp_dir.ts";

describe("realLocal", () => {
  // Every row is an absolute path nothing exists under, so the real path is the typed one and the
  // label in the refusal is what the user would see recorded.
  const unstorable: [string, RegExp][] = [
    [
      "a\n",
      /^".*a\\n": a path cannot contain a line break; a path cannot start or end with whitespace$/,
    ],
    ["a\0", /^".*a\\u0000": a path cannot contain NUL$/],
    ["a ", /^".*a ": a path cannot start or end with whitespace$/],
    ["a-->", /^".*a-->": a path cannot contain -->$/],
  ];
  test.each(unstorable)("refuses a real path ending in %j as usage", (tail, message) => {
    const path = join("/", "nowhere", "maxims-sources-test", tail);
    let caught: unknown;
    try {
      realLocal({ type: "local", path });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaximsError);
    expect((caught as MaximsError).code).toBe(ExitCode.Usage);
    expect((caught as MaximsError).message).toMatch(message);
  });

  test.skipIf(WINDOWS)(
    "judges the directory an alias points at, not the alias the user typed",
    async () => {
      await withTempDir(async (dir) => {
        mkdirSync(join(dir, "clean"));
        symlinkSync(join(dir, "clean"), join(dir, "alias-->"));
        expect(realLocal({ type: "local", path: join(dir, "alias-->"), live: true })).toEqual({
          type: "local",
          path: realpathSync(join(dir, "clean")),
          live: true,
        });
      });
    },
  );
});
