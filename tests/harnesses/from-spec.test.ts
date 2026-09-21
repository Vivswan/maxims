// Guards the compiler behaviors no single built-in folder exercises on its own; each would
// otherwise break only in the one harness that happens to use it, with nothing else going red.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookSpecFor } from "../../src/harnesses/contract.ts";
import { toDefinition } from "../../src/harnesses/from-spec.ts";
import { type HarnessSpec, parseHarnessSpec } from "../../src/harnesses/spec.ts";
import { ExitCode, MaximsError } from "../../src/util/exit-codes.ts";
import { CHMOD_DENIES } from "../shared/platform.ts";
import { withTempDir } from "../shared/temp_dir.ts";

const globs = ["src/**", "docs/**"];

// A spec with a user-defined id reaches the compiler only through the parser, which is where such
// an id is minted.
function specOf(json: unknown): HarnessSpec {
  const parsed = parseHarnessSpec(json);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.spec;
}

const rendering = specOf({
  id: "example",
  displayName: "Example",
  tier: 1,
  verifiedAgainst: { date: "2026-09-20", pages: [{ url: "https://example.com/docs/hooks" }] },
  globalRoot: { default: "~/.config/example", env: { name: "XDG_CONFIG_HOME", subdir: "example" } },
  targets: {
    project: {
      kind: "rules-dir",
      dir: ".example/rules",
      fileName: "maxims-{{slug}}.md",
      frontmatter: { always: { trigger: "always_on" } },
    },
    global: { kind: "shared-block", file: "AGENTS.md", precedence: ["RULES.md", "AGENTS.md"] },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: [],
  detect: { dirs: ["."] },
  scopeFrontmatter: { fields: {}, pathsKey: "paths", pathsAs: "list" },
  mcp: { path: { project: null, global: "mcp.json" }, serversPath: ["servers", "mcp"] },
  hook: {
    kind: "registry",
    path: { project: ".example/hooks.json", global: "hooks.json" },
    format: "json",
    eventPath: ["hooks", "start"],
    grouped: false,
    wrapper: { version: 1 },
    handlerTemplate: {
      run: "{{command}}",
      argv: "{{argv}}",
      label: "sync via {{command}} in {{timeoutSeconds}}s",
      nested: { background: "{{async}}", limits: ["{{timeoutMs}}", "{{timeoutSeconds}}"] },
    },
    commandKey: "run",
    stdout: "none",
    async: true,
    debounceMs: 60_000,
  },
});

// A handler value that is exactly one placeholder takes the placeholder's own JSON type, so the
// registry carries `"async": true` and `"timeout": 20000` rather than their quoted spellings,
// which Codex and Gemini would reject or misread.
test("placeholders keep their JSON type when they stand alone and splice as text otherwise", () => {
  const def = toDefinition(rendering);
  if (def.hook.kind !== "registry") throw new Error("expected a registry hook");
  expect(JSON.stringify(def.hook.handler(hookSpecFor(def)))).toBe(
    '{"run":"npx -y @vivswan/maxims sync --quiet","argv":["npx","-y","@vivswan/maxims","sync","--quiet"],"label":"sync via npx -y @vivswan/maxims sync --quiet in 20s","nested":{"background":true,"limits":[20000,20]}}',
  );
});

test("a file template splices argv as a JSON array and the timeout in milliseconds", () => {
  const def = toDefinition(
    specOf({
      ...rendering,
      hook: {
        kind: "file",
        path: { project: ".example/ext.ts", global: "extensions/ext.ts" },
        contentTemplate: "run({{argv}}, { timeout: {{timeoutMs}} });\n",
        executable: false,
        stdout: "none",
      },
    }),
  );
  if (def.hook.kind !== "file") throw new Error("expected a file hook");
  expect(def.hook.render(hookSpecFor(def))).toBe(
    'run(["npx","-y","@vivswan/maxims","sync","--quiet"], { timeout: 20000 });\n',
  );
});

// A `--paths` install on a harness whose rules have no scoped form must not fall back to the
// always-on preamble, which would install the rules everywhere the user asked to narrow them.
test("frontmatter without a scoped form refuses paths out loud and fences the always-on fields", () => {
  const def = toDefinition(rendering);
  const target = def.targets.project;
  if (target?.kind !== "rules-dir" || target.frontmatter === undefined) throw new Error("no fm");
  expect(target.frontmatter({})).toBe("---\ntrigger: always_on\n---\n");
  let caught: unknown;
  try {
    target.frontmatter({ paths: globs });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MaximsError);
  expect((caught as MaximsError).code).toBe(ExitCode.Usage);
  expect(def.scopeFrontmatter?.([])).toBeNull();
  expect(def.scopeFrontmatter?.(globs)).toBe("---\npaths:\n  - src/**\n  - docs/**\n---\n");
});

// Cursor reads `globs` between `description` and `alwaysApply`; a YAML reader does not care, but
// the written bytes are what the folder test pins, so the placement is part of the contract.
test("a null paths key among the scoped fields fixes where the paths land", () => {
  const def = toDefinition(
    specOf({
      ...rendering,
      targets: {
        ...rendering.targets,
        project: {
          kind: "rules-dir",
          dir: ".example/rules",
          fileName: "maxims-{{slug}}.md",
          frontmatter: {
            always: { mode: "always" },
            scoped: {
              fields: { mode: "glob", globs: null, alwaysApply: false },
              pathsKey: "globs",
              pathsAs: "list",
            },
          },
        },
      },
    }),
  );
  const target = def.targets.project;
  if (target?.kind !== "rules-dir" || target.frontmatter === undefined) throw new Error("no fm");
  expect(target.frontmatter({ paths: globs })).toBe(
    "---\nmode: glob\nglobs:\n  - src/**\n  - docs/**\nalwaysApply: false\n---\n",
  );
});

test("the global root joins the env override with its subdirectory and strips ~/ from the default", () => {
  const def = toDefinition(rendering);
  const home = resolve("/home/user");
  const xdg = resolve("/xdg");
  expect(def.globalRoot?.({ home, projectRoot: null, env: {} })).toBe(
    resolve("/home/user/.config/example"),
  );
  expect(def.globalRoot?.({ home, projectRoot: null, env: { XDG_CONFIG_HOME: xdg } })).toBe(
    resolve("/xdg/example"),
  );
  expect(def.globalRoot?.({ home, projectRoot: null, env: { XDG_CONFIG_HOME: "" } })).toBe(
    resolve("/home/user/.config/example"),
  );
  expect(def.mcp?.path("project", { home, projectRoot: resolve("/p"), env: {} })).toBeNull();
  expect(def.mcp?.path("global", { home, projectRoot: null, env: {} })).toBe(
    resolve("/home/user/.config/example/mcp.json"),
  );
});

// The nightly drift check reads the pages off the compiled definition, so a compiler that kept
// only the first page, or dropped a hash or note, would silently stop watching the rest.
test("every verified page reaches the definition with its hash and note", () => {
  const hash = `sha256:${"ab".repeat(32)}`;
  const pages = [
    { url: "https://example.com/docs/hooks", contentHash: hash, note: "hook shape" },
    { url: "https://example.com/docs/rules", note: "rules directory" },
  ];
  const def = toDefinition(
    specOf({ ...rendering, verifiedAgainst: { date: "2026-09-21", pages } }),
  );
  expect<unknown>(def.verifiedAgainst).toEqual({ date: "2026-09-21", pages });
});

test("a reconcile quirk becomes the custom hook of a spec that declares none", () => {
  const reconcile = async () => [];
  const custom = toDefinition(specOf({ ...rendering, hook: { kind: "none" } }), { reconcile });
  expect(custom.hook).toEqual({ kind: "custom", reconcile });
});

// A probe that reads a file under the global root must see the root the spec resolves, override
// included; a quirk written against a root of its own would read a stale path once the spec's
// `globalRoot` moved.
test("quirks given as a function receive the compiled data definition", async () => {
  const xdg = resolve("/xdg");
  const def = toDefinition(rendering, (declared) => ({
    achievedTier: async (ctx) => ({
      tier: declared.globalRoot?.(ctx) === join(xdg, "example") ? 2 : 1,
      unreadable: null,
    }),
  }));
  const home = resolve("/home/user");
  expect(await def.achievedTier?.({ home, projectRoot: null, env: {} })).toEqual({
    tier: 1,
    unreadable: null,
  });
  expect(
    await def.achievedTier?.({ home, projectRoot: null, env: { XDG_CONFIG_HOME: xdg } }),
  ).toEqual({ tier: 2, unreadable: null });
});

// Detection reads a directory it cannot inspect as an error, not as "not installed": a
// permission problem on the config directory is something to show, and a silent false would
// hide the harness from every command.
test.skipIf(!CHMOD_DENIES)("a detection lookup that fails surfaces its error", async () => {
  await withTempDir((dir) => {
    const def = toDefinition({
      ...rendering,
      globalRoot: undefined,
      detect: { dirs: ["locked/inner"] },
    });
    mkdirSync(join(dir, "locked", "inner"), { recursive: true });
    chmodSync(join(dir, "locked"), 0o000);
    try {
      expect(() => def.detect({ home: dir, projectRoot: null, env: {} })).toThrow(/EACCES/);
    } finally {
      chmodSync(join(dir, "locked"), 0o755);
    }
  });
});
