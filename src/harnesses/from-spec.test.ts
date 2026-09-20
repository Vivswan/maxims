// Guards that a spec compiles into the definition its hand-written twin declares: every data
// member equal, and every function equal on the fixture contexts (paths under the home, under an
// overridden global root, and with no project; the rendered handler or hook file; detection on
// real directories). A path, a byte of a hook, or a tier that moved between the two would let the
// hand-written folders be replaced by specs while the harness quietly reads a different file.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../../tests/shared/temp_dir.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { cline } from "./cline/index.ts";
import { codex } from "./codex/index.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  hookSpecFor,
  type Scope,
  type Target,
} from "./contract.ts";
import { copilot } from "./copilot/index.ts";
import { type HarnessQuirks, toDefinition } from "./from-spec.ts";
import { geminiCli } from "./gemini-cli/index.ts";
import { type HarnessSpec, parseHarnessSpec } from "./spec.ts";

const scopes: Scope[] = ["project", "global"];
const slug = "example-user-doctrine";
const globs = ["src/**", "docs/**"];

const codexSpec: HarnessSpec = {
  id: "codex",
  displayName: "Codex",
  tier: 1,
  verifiedAgainst: { url: "https://learn.chatgpt.com/docs/hooks", date: "2026-09-20" },
  globalRoot: { default: ".codex", env: { name: "CODEX_HOME" } },
  targets: {
    project: { kind: "shared-block", file: "AGENTS.md" },
    global: { kind: "shared-block", file: "AGENTS.md" },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: [],
  detect: { dirs: ["."] },
  hook: {
    kind: "registry",
    path: { project: ".codex/hooks.json", global: "hooks.json" },
    format: "json",
    eventPath: ["hooks", "SessionStart"],
    grouped: true,
    handlerTemplate: {
      type: "command",
      command: "{{command}}",
      timeout: "{{timeoutSeconds}}",
      async: "{{async}}",
      statusMessage: "Syncing maxims",
    },
    commandKey: "command",
    stdout: "plain",
    async: true,
    tierCheck: {
      path: { project: ".codex/config.toml", global: "config.toml" },
      format: "toml",
      key: "features.hooks",
      demotesWhen: false,
    },
  },
  fixtures: { config: "hooks.json", hookStdin: "hook-stdin.json" },
};

const geminiSpec: HarnessSpec = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  tier: 1,
  verifiedAgainst: {
    url: "https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/reference.md",
    date: "2026-09-20",
  },
  targets: {
    project: { kind: "shared-block", file: "GEMINI.md" },
    global: { kind: "shared-block", file: ".gemini/GEMINI.md" },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: ["at-import"],
  detect: { dirs: [".gemini"] },
  hook: {
    kind: "registry",
    path: { project: ".gemini/settings.json", global: ".gemini/settings.json" },
    format: "json",
    eventPath: ["hooks", "SessionStart"],
    grouped: true,
    handlerTemplate: {
      name: "maxims-sync",
      type: "command",
      command: "{{command}}",
      timeout: "{{timeoutMs}}",
    },
    commandKey: "command",
    stdout: "json:hookSpecificOutput.additionalContext",
    async: false,
  },
  fixtures: { config: "settings.json", hookStdin: "hook-stdin.json" },
};

const copilotSpec: HarnessSpec = {
  id: "copilot",
  displayName: "GitHub Copilot",
  tier: 1,
  verifiedAgainst: {
    url: "https://docs.github.com/en/copilot/reference/hooks-configuration",
    date: "2026-09-20",
  },
  globalRoot: { default: ".copilot", env: { name: "COPILOT_HOME" } },
  targets: {
    project: {
      kind: "rules-dir",
      dir: ".github/instructions",
      fileName: "maxims-{{slug}}.instructions.md",
      frontmatter: {
        always: { applyTo: "**" },
        scoped: { fields: {}, pathsKey: "applyTo", pathsAs: "comma-list" },
      },
    },
    global: {
      kind: "rules-dir",
      dir: "instructions",
      fileName: "maxims-{{slug}}.instructions.md",
      frontmatter: {
        always: { applyTo: "**" },
        scoped: { fields: {}, pathsKey: "applyTo", pathsAs: "comma-list" },
      },
    },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: [],
  detect: { dirs: ["."] },
  hook: {
    kind: "file",
    path: { project: ".github/hooks/maxims.json", global: "hooks/maxims.json" },
    contentTemplate: [
      "{",
      '  "version": 1,',
      '  "hooks": {',
      '    "sessionStart": [',
      "      {",
      '        "type": "command",',
      '        "bash": "{{command}}",',
      '        "powershell": "{{command}}",',
      '        "timeoutSec": {{timeoutSeconds}}',
      "      }",
      "    ]",
      "  }",
      "}",
      "",
    ].join("\n"),
    executable: false,
    stdout: "json:additionalContext",
  },
  fixtures: { hookStdin: "hook-stdin.json" },
};

const clineSpec: HarnessSpec = {
  id: "cline",
  displayName: "Cline",
  tier: 1,
  verifiedAgainst: {
    url: "https://raw.githubusercontent.com/cline/cline/main/.clinerules/hooks/README.md",
    date: "2026-09-20",
  },
  targets: {
    project: { kind: "rules-dir", dir: ".clinerules", fileName: "maxims-{{slug}}.md" },
    global: { kind: "rules-dir", dir: "Documents/Cline/Rules", fileName: "maxims-{{slug}}.md" },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: [],
  detect: { dirs: ["Documents/Cline", ".cline"] },
  hook: {
    kind: "file",
    path: { project: ".clinerules/hooks/TaskStart", global: "Documents/Cline/Hooks/TaskStart" },
    contentTemplate: [
      "#!/usr/bin/env sh",
      "# Written by maxims. Remove it with `maxims remove` or delete this file; edits are overwritten.",
      "{{command}} </dev/null >/dev/null 2>&1",
      `printf '%s\\n' '{"cancel": false}'`,
      "",
    ].join("\n"),
    executable: true,
    stdout: "none",
  },
  fixtures: { hookStdin: "hook-stdin.json" },
};

// One home per install footprint: a compiled detector that reads another harness's directory
// disagrees with its hand-written twin on the home where only that directory exists, which one
// home holding every footprint could never show. `Documents` alone is a footprint so a detector
// that stops one level short of `Documents/Cline` is seen too.
const FOOTPRINTS = [".codex", ".copilot", ".gemini", "Documents", "Documents/Cline", ".cline"];
// Each global-root variable is set on its own, so a detector reading the other harness's
// variable disagrees on the context where only its own is set.
const ROOT_VARIABLES = ["CODEX_HOME", "COPILOT_HOME"];

type Fixture = {
  ctxs: HarnessContext[];
};

async function withFixture<T>(fn: (fixture: Fixture) => Promise<T> | T): Promise<T> {
  return withTempDir((dir) => {
    const empty = join(dir, "empty-home");
    const present = join(dir, "present");
    const project = join(dir, "project");
    mkdirSync(empty);
    mkdirSync(present);
    mkdirSync(project);
    const footprintHomes = FOOTPRINTS.map((sub, index) => {
      const home = join(dir, `home-${index}`);
      mkdirSync(join(home, sub), { recursive: true });
      return home;
    });
    writeFileSync(join(dir, "a-file"), "");
    const overrideValues = [present, join(dir, "missing"), join(dir, "a-file"), "relative-home"];
    return fn({
      ctxs: [
        { home: empty, projectRoot: project, env: {} },
        ...footprintHomes.map((home) => ({ home, projectRoot: project, env: {} })),
        ...ROOT_VARIABLES.flatMap((name) =>
          overrideValues.map((value) => ({
            home: empty,
            projectRoot: project,
            env: { [name]: value },
          })),
        ),
        { home: empty, projectRoot: null, env: {} },
      ],
    });
  });
}

// A member that throws is recorded as the exit code it throws with, so a project path with no
// project root compares as "usage error" on both sides rather than aborting the comparison.
function outcome(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (error) {
    if (error instanceof MaximsError) return { throws: error.code };
    throw error;
  }
}

function targetPortrait(target: Target | null): unknown {
  if (target === null) return null;
  if (target.kind === "shared-block") return target;
  return {
    kind: target.kind,
    dir: target.dir,
    fileName: target.fileName(slug),
    frontmatter:
      target.frontmatter === undefined
        ? undefined
        : {
            always: target.frontmatter({}),
            emptyPaths: target.frontmatter({ paths: [] }),
            scoped: outcome(() => target.frontmatter?.({ paths: globs })),
          },
  };
}

function hookPortrait(def: HarnessDefinition, ctxs: HarnessContext[]): unknown {
  const hook = def.hook;
  if (hook.kind === "none" || hook.kind === "custom") return { kind: hook.kind };
  const paths = ctxs.map((ctx) => scopes.map((scope) => outcome(() => hook.path(scope, ctx))));
  if (hook.kind === "file") {
    return {
      kind: hook.kind,
      paths,
      rendered: hook.render(hookSpecFor(def)),
      executable: hook.executable,
      stdout: hook.stdout,
    };
  }
  return {
    kind: hook.kind,
    paths,
    format: hook.format,
    eventPath: hook.eventPath,
    grouped: hook.grouped,
    wrapper: hook.wrapper,
    handler: hook.handler(hookSpecFor(def)),
    commandKey: hook.commandKey,
    stdout: hook.stdout,
    async: hook.async,
    debounceMs: hook.debounceMs,
    tierCheck:
      hook.tierCheck === undefined
        ? undefined
        : {
            paths: ctxs.map((ctx) =>
              scopes.map((scope) => outcome(() => hook.tierCheck?.path(scope, ctx))),
            ),
            format: hook.tierCheck.format,
            key: hook.tierCheck.key,
            demotesWhen: hook.tierCheck.demotesWhen,
          },
  };
}

function portrait(def: HarnessDefinition, ctxs: HarnessContext[]): Record<string, unknown> {
  return {
    id: def.id,
    displayName: def.displayName,
    tier: def.tier,
    targets: {
      project: targetPortrait(def.targets.project),
      global: targetPortrait(def.targets.global),
    },
    bodiesDir: ctxs.map((ctx) => scopes.map((scope) => outcome(() => def.bodiesDir(scope, ctx)))),
    hook: hookPortrait(def, ctxs),
    markers: def.markers,
    expands: def.expands,
    byteBudget: def.byteBudget,
    detect: ctxs.map((ctx) => def.detect(ctx)),
    scopeFrontmatter:
      def.scopeFrontmatter === undefined
        ? undefined
        : [def.scopeFrontmatter([]), def.scopeFrontmatter(globs)],
    verifiedAgainst: def.verifiedAgainst,
    fixtures: def.fixtures,
    globalRoot: def.globalRoot === undefined ? undefined : ctxs.map((ctx) => def.globalRoot?.(ctx)),
    mcp:
      def.mcp === undefined
        ? undefined
        : {
            paths: ctxs.map((ctx) =>
              scopes.map((scope) => outcome(() => def.mcp?.path(scope, ctx))),
            ),
            serversPath: def.mcp.serversPath,
          },
    hasAchievedTier: def.achievedTier !== undefined,
    hasConfigEdit: def.configEdit !== undefined,
  };
}

const landed: [string, HarnessDefinition, HarnessSpec, HarnessQuirks][] = [
  ["codex", codex, codexSpec, { achievedTier: codex.achievedTier }],
  ["gemini-cli", geminiCli, geminiSpec, {}],
  ["copilot", copilot, copilotSpec, {}],
  ["cline", cline, clineSpec, {}],
];

test.each(landed)(
  "%s compiled from its spec matches the hand-written definition",
  async (_, handWritten, spec, quirks) => {
    await withFixture(({ ctxs }) => {
      const compiled = toDefinition(spec, quirks);
      expect(portrait(compiled, ctxs)).toEqual(portrait(handWritten, ctxs));
      expect(compiled.achievedTier).toBe(handWritten.achievedTier);
    });
  },
);

// A spec with a user-defined id reaches the compiler only through the parser, which is where such
// an id is minted.
function specOf(json: unknown): HarnessSpec {
  const parsed = parseHarnessSpec(json);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.spec;
}

const rendering = specOf({
  ...codexSpec,
  id: "example",
  displayName: "Example",
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
  fixtures: undefined,
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

test("the global root joins the env override with its subdirectory and strips ~/ from the default", () => {
  const def = toDefinition(rendering);
  const home = "/home/user";
  expect(def.globalRoot?.({ home, projectRoot: null, env: {} })).toBe("/home/user/.config/example");
  expect(def.globalRoot?.({ home, projectRoot: null, env: { XDG_CONFIG_HOME: "/xdg" } })).toBe(
    "/xdg/example",
  );
  expect(def.globalRoot?.({ home, projectRoot: null, env: { XDG_CONFIG_HOME: "" } })).toBe(
    "/home/user/.config/example",
  );
  expect(def.mcp?.path("project", { home, projectRoot: "/p", env: {} })).toBeNull();
  expect(def.mcp?.path("global", { home, projectRoot: null, env: {} })).toBe(
    "/home/user/.config/example/mcp.json",
  );
});

test("a reconcile quirk becomes the custom hook of a spec that declares none", () => {
  const reconcile = async () => [];
  const custom = toDefinition(specOf({ ...rendering, hook: { kind: "none" } }), { reconcile });
  expect(custom.hook).toEqual({ kind: "custom", reconcile });
});

// Detection reads a directory it cannot inspect as an error, not as "not installed": a
// permission problem on the config directory is something to show, and a silent false would
// hide the harness from every command.
test.skipIf(process.getuid?.() === 0)(
  "a detection lookup that fails surfaces its error",
  async () => {
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
  },
);
