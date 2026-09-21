// Guards the extension file Pi loads and what moves with `PI_CODING_AGENT_DIR`: the default
// export takes the extension API, `session_start` runs the sync through `pi.exec` with an argv
// (not a shell string) and a millisecond timeout inside a try, and the global AGENTS.md and the
// extension both follow the overridden directory, while the variable alone never counts as an
// install. Also guards that a directory's `AGENTS.override.md` receives the block, since Pi loads
// it instead of AGENTS.md.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookSpecFor, scopeRoot, sharedBlockFile } from "../../../src/harnesses/contract.ts";
import { pi } from "../../../src/harnesses/pi/index.ts";
import { withTempDir } from "../../shared/temp_dir.ts";

test("the extension file is written byte for byte as Pi loads it", () => {
  if (pi.hook.kind !== "file") throw new Error("expected a file hook");
  expect(pi.hook.render(hookSpecFor(pi))).toBe(
    [
      "// Written by maxims. It runs the maxims sync whenever a Pi session starts so the rule files",
      "// stay current. maxims rewrites this file on every sync while a source in its state still",
      "// wants a hook for Pi; removing the last such source deletes it.",
      'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
      "",
      "export default function (pi: ExtensionAPI) {",
      '  pi.on("session_start", async () => {',
      '    const [command, ...args] = ["npx","-y","@vivswan/maxims","sync","--quiet"];',
      "    try {",
      "      await pi.exec(command, args, { timeout: 20000 });",
      "    } catch {",
      "      // An offline npx is not an extension error; the rules keep their last synced state.",
      "    }",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
});

test("$PI_CODING_AGENT_DIR moves the global AGENTS.md and the extension, even when relative", () => {
  if (pi.hook.kind !== "file") throw new Error("expected a file hook");
  const target = pi.targets.global;
  if (target?.kind !== "shared-block") throw new Error("expected a shared block");
  const home = resolve("/home/user");
  const plain = { home, projectRoot: null, env: {} };
  expect(join(scopeRoot(pi, "global", plain), target.file)).toBe(
    resolve("/home/user/.pi/agent/AGENTS.md"),
  );
  expect(pi.hook.path("global", plain)).toBe(resolve("/home/user/.pi/agent/extensions/maxims.ts"));
  const moved = { home, projectRoot: null, env: { PI_CODING_AGENT_DIR: resolve("/opt/pi") } };
  expect(join(scopeRoot(pi, "global", moved), target.file)).toBe(resolve("/opt/pi/AGENTS.md"));
  expect(pi.hook.path("global", moved)).toBe(resolve("/opt/pi/extensions/maxims.ts"));
  const relative = { home, projectRoot: null, env: { PI_CODING_AGENT_DIR: "custom-pi" } };
  expect(pi.hook.path("global", relative)).toBe(
    join(process.cwd(), "custom-pi/extensions/maxims.ts"),
  );
  expect(pi.hook.path("project", { ...plain, projectRoot: resolve("/home/user/project") })).toBe(
    resolve("/home/user/project/.pi/extensions/maxims.ts"),
  );
});

test("detection follows the config directory, not the exported variable", async () => {
  await withTempDir((dir) => {
    const home = join(dir, "home");
    const present = join(dir, "present");
    mkdirSync(present, { recursive: true });
    writeFileSync(join(dir, "a-file"), "");
    const at = (value: string | undefined) => ({
      home,
      projectRoot: null,
      env: value === undefined ? {} : { PI_CODING_AGENT_DIR: value },
    });
    expect(pi.detect(at(present))).toBe(true);
    expect(pi.detect(at(join(dir, "missing")))).toBe(false);
    expect(pi.detect(at(join(dir, "a-file")))).toBe(false);
    expect(pi.detect(at(undefined))).toBe(false);
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    expect(pi.detect(at(undefined))).toBe(true);
  });
});

test("AGENTS.override.md receives the block in a directory that has one", async () => {
  const target = pi.targets.project;
  if (target?.kind !== "shared-block") throw new Error("expected a shared block");
  await withTempDir((repo) => {
    writeFileSync(join(repo, "AGENTS.md"), "");
    expect(sharedBlockFile(target, repo)).toBe("AGENTS.md");
    writeFileSync(join(repo, "AGENTS.override.md"), "");
    expect(sharedBlockFile(target, repo)).toBe("AGENTS.override.md");
  });
});
