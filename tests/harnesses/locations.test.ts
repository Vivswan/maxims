// Where each vendor looks, pinned as the paths and names that reach it: the rule file a scope's
// block lands in, the hook artifact, the MCP servers file, which directory counts as an install,
// and which of several instruction files receives the block. A spec supplies relative pieces; a
// row here is their composition under the roots and overrides, which only the vendor's own loader
// enforces.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type BuiltInHarnessId, HARNESS_IDS } from "../../src/contracts/harness-id.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  type Scope,
  type SourceSlug,
  sharedBlockFile,
} from "../../src/harnesses/contract.ts";
import { hasHook, hookPath } from "../../src/harnesses/hook-writer.ts";
import { HARNESSES } from "../../src/harnesses/registry.ts";
import { rulesDirPath } from "../../src/harnesses/strategies/rules-dir.ts";
import { sharedBlockPath } from "../../src/harnesses/strategies/shared-block.ts";
import { withTempDir } from "../shared/temp_dir.ts";
import { exampleContext } from "./context.ts";

const scopes: Scope[] = ["project", "global"];
const slug = "example-user-doctrine" as SourceSlug;

function definitionOf(id: BuiltInHarnessId): HarnessDefinition {
  const def = HARNESSES.find((candidate) => candidate.id === id);
  if (def === undefined) throw new Error(`${id} is not registered`);
  return def;
}

function make(dir: string, entry: string): void {
  const path = join(dir, entry);
  if (entry.endsWith("/")) {
    mkdirSync(path, { recursive: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
}

type Files = { rule: string | null; hook: string | null; mcp: string | null };

function filesOf(def: HarnessDefinition, scope: Scope, ctx: HarnessContext): Files {
  const target = def.targets[scope];
  const rule =
    target === null
      ? null
      : target.kind === "rules-dir"
        ? rulesDirPath({ def, target, scope, ctx, sourceSlug: slug })
        : sharedBlockPath({ def, target, scope, ctx });
  const hook = hasHook(def, "registry") || hasHook(def, "file") ? hookPath(def, scope, ctx) : null;
  return { rule, hook, mcp: def.mcp?.path(scope, ctx) ?? null };
}

const resolvedFiles = (files: Files): Files => ({
  rule: files.rule === null ? null : resolve(files.rule),
  hook: files.hook === null ? null : resolve(files.hook),
  mcp: files.mcp === null ? null : resolve(files.mcp),
});

const AT_HOME: Record<BuiltInHarnessId, Record<Scope, Files>> = {
  "claude-code": {
    project: {
      rule: "/home/user/project/.claude/rules/maxims-example-user-doctrine.md",
      hook: "/home/user/project/.claude/settings.json",
      mcp: null,
    },
    global: {
      rule: "/home/user/.claude/rules/maxims-example-user-doctrine.md",
      hook: "/home/user/.claude/settings.json",
      mcp: null,
    },
  },
  codex: {
    project: {
      rule: "/home/user/project/AGENTS.md",
      hook: "/home/user/project/.codex/hooks.json",
      mcp: null,
    },
    global: {
      rule: "/home/user/.codex/AGENTS.md",
      hook: "/home/user/.codex/hooks.json",
      mcp: null,
    },
  },
  "gemini-cli": {
    project: {
      rule: "/home/user/project/GEMINI.md",
      hook: "/home/user/project/.gemini/settings.json",
      mcp: null,
    },
    global: {
      rule: "/home/user/.gemini/GEMINI.md",
      hook: "/home/user/.gemini/settings.json",
      mcp: null,
    },
  },
  copilot: {
    project: {
      rule: "/home/user/project/.github/instructions/maxims-example-user-doctrine.instructions.md",
      hook: "/home/user/project/.github/hooks/maxims.json",
      mcp: null,
    },
    global: {
      rule: "/home/user/.copilot/instructions/maxims-example-user-doctrine.instructions.md",
      hook: "/home/user/.copilot/hooks/maxims.json",
      mcp: null,
    },
  },
  cursor: {
    project: {
      rule: "/home/user/project/.cursor/rules/maxims-example-user-doctrine.mdc",
      hook: "/home/user/project/.cursor/hooks.json",
      mcp: null,
    },
    global: { rule: null, hook: "/home/user/.cursor/hooks.json", mcp: null },
  },
  cline: {
    project: {
      rule: "/home/user/project/.clinerules/maxims-example-user-doctrine.md",
      hook: "/home/user/project/.clinerules/hooks/TaskStart",
      mcp: null,
    },
    global: {
      rule: "/home/user/Documents/Cline/Rules/maxims-example-user-doctrine.md",
      hook: "/home/user/Documents/Cline/Hooks/TaskStart",
      mcp: null,
    },
  },
  opencode: {
    project: {
      rule: "/home/user/project/.opencode/memories/maxims-example-user-doctrine.md",
      hook: "/home/user/project/.opencode/plugins/maxims.ts",
      mcp: null,
    },
    global: {
      rule: "/home/user/.config/opencode/AGENTS.md",
      hook: "/home/user/.config/opencode/plugins/maxims.ts",
      mcp: null,
    },
  },
  dsh: {
    project: { rule: "/home/user/project/AGENTS.md", hook: null, mcp: null },
    global: { rule: "/home/user/.dsh/AGENTS.md", hook: null, mcp: null },
  },
  devin: {
    project: {
      rule: "/home/user/project/AGENTS.md",
      hook: "/home/user/project/.devin/config.json",
      mcp: "/home/user/project/.devin/mcp_config.json",
    },
    global: {
      rule: "/home/user/.config/devin/AGENTS.md",
      hook: "/home/user/.config/devin/config.json",
      mcp: "/home/user/.config/devin/mcp_config.json",
    },
  },
  windsurf: {
    project: {
      rule: "/home/user/project/.devin/rules/maxims-example-user-doctrine.md",
      hook: "/home/user/project/.devin/hooks.json",
      mcp: null,
    },
    global: {
      rule: "/home/user/.codeium/windsurf/memories/global_rules.md",
      hook: "/home/user/.codeium/windsurf/hooks.json",
      mcp: null,
    },
  },
  zed: {
    project: {
      rule: "/home/user/project/AGENTS.md",
      hook: null,
      mcp: "/home/user/project/.zed/settings.json",
    },
    global: {
      rule: "/home/user/.config/zed/AGENTS.md",
      hook: null,
      mcp: "/home/user/.config/zed/settings.json",
    },
  },
  amp: {
    project: {
      rule: "/home/user/project/AGENTS.md",
      hook: "/home/user/project/.amp/plugins/maxims.ts",
      mcp: "/home/user/project/.amp/settings.json",
    },
    global: {
      rule: "/home/user/.config/amp/AGENTS.md",
      hook: "/home/user/.config/amp/plugins/maxims.ts",
      mcp: "/home/user/.config/amp/settings.json",
    },
  },
  warp: {
    project: { rule: "/home/user/project/AGENTS.md", hook: null, mcp: null },
    global: { rule: null, hook: null, mcp: "/home/user/.warp/.mcp.json" },
  },
  pi: {
    project: {
      rule: "/home/user/project/AGENTS.md",
      hook: "/home/user/project/.pi/extensions/maxims.ts",
      mcp: "/home/user/project/.pi/mcp.json",
    },
    global: {
      rule: "/home/user/.pi/agent/AGENTS.md",
      hook: "/home/user/.pi/agent/extensions/maxims.ts",
      mcp: "/home/user/.pi/agent/mcp.json",
    },
  },
};

// A relocated config directory moves every user-level file with it, and a variable the vendor's
// docs do not honour moves nothing. A relative override resolves against the working directory,
// which tests/harnesses/from-spec.test.ts pins once for the compiler.
const RELOCATED: [string, BuiltInHarnessId, Record<string, string>, Files][] = [
  [
    "$CODEX_HOME",
    "codex",
    { CODEX_HOME: "/home/user/custom-codex" },
    {
      rule: "/home/user/custom-codex/AGENTS.md",
      hook: "/home/user/custom-codex/hooks.json",
      mcp: null,
    },
  ],
  [
    "$COPILOT_HOME",
    "copilot",
    { COPILOT_HOME: "/home/user/custom-copilot" },
    {
      rule: "/home/user/custom-copilot/instructions/maxims-example-user-doctrine.instructions.md",
      hook: "/home/user/custom-copilot/hooks/maxims.json",
      mcp: null,
    },
  ],
  [
    "$XDG_CONFIG_HOME",
    "opencode",
    { XDG_CONFIG_HOME: "/home/user/xdg" },
    {
      rule: "/home/user/xdg/opencode/AGENTS.md",
      hook: "/home/user/xdg/opencode/plugins/maxims.ts",
      mcp: null,
    },
  ],
  [
    "$XDG_CONFIG_HOME",
    "zed",
    { XDG_CONFIG_HOME: "/xdg" },
    { rule: "/xdg/zed/AGENTS.md", hook: null, mcp: "/xdg/zed/settings.json" },
  ],
  [
    "$XDG_CONFIG_HOME, which Amp's docs leave out of its root",
    "amp",
    { XDG_CONFIG_HOME: "/xdg" },
    AT_HOME.amp.global,
  ],
  [
    "$DSH_HOME",
    "dsh",
    { DSH_HOME: "/home/user/dsh-home" },
    { rule: "/home/user/dsh-home/AGENTS.md", hook: null, mcp: null },
  ],
  [
    "$PI_CODING_AGENT_DIR",
    "pi",
    { PI_CODING_AGENT_DIR: "/opt/pi" },
    { rule: "/opt/pi/AGENTS.md", hook: "/opt/pi/extensions/maxims.ts", mcp: "/opt/pi/mcp.json" },
  ],
];

type FilesRow = [BuiltInHarnessId, Scope, string, Record<string, string>, Files];

const filesRows: FilesRow[] = [
  ...HARNESS_IDS.flatMap((id) =>
    scopes.map((scope): FilesRow => [id, scope, "the home", {}, AT_HOME[id][scope]]),
  ),
  ...RELOCATED.map(([label, id, env, files]): FilesRow => [id, "global", label, env, files]),
];

test.each(filesRows)(
  "%s: the %s files under %s land where it reads them",
  (id, scope, _label, env, files) => {
    expect(filesOf(definitionOf(id), scope, { ...exampleContext, env })).toEqual(
      resolvedFiles(files),
    );
  },
);

// What counts as an install: a directory where the vendor keeps its config, never a stray file of
// that name, and a relocation variable alone never counts while a session variable (Claude Code's)
// does.
type Layout = [label: string, entries: string[], env: Record<string, string>, installed: boolean];

const INSTALLS: Record<BuiltInHarnessId, Layout[]> = {
  "claude-code": [
    ["CLAUDECODE exported and nothing on disk", [], { CLAUDECODE: "1" }, true],
    [
      "CLAUDE_CODE_ENTRYPOINT exported and nothing on disk",
      [],
      { CLAUDE_CODE_ENTRYPOINT: "cli" },
      true,
    ],
    ["a stray file named .claude", ["home/.claude"], {}, false],
    ["~/.claude", ["home/.claude/"], {}, true],
  ],
  codex: [
    ["$CODEX_HOME naming a directory", ["elsewhere/"], { CODEX_HOME: "./elsewhere" }, true],
    ["$CODEX_HOME naming a missing path", [], { CODEX_HOME: "./missing" }, false],
    ["$CODEX_HOME naming a file", ["a-file"], { CODEX_HOME: "./a-file" }, false],
    ["~/.codex", ["home/.codex/"], {}, true],
  ],
  "gemini-cli": [["~/.gemini", ["home/.gemini/"], {}, true]],
  copilot: [
    ["$COPILOT_HOME naming a directory", ["elsewhere/"], { COPILOT_HOME: "./elsewhere" }, true],
    ["$COPILOT_HOME naming a missing path", [], { COPILOT_HOME: "./missing" }, false],
    ["$COPILOT_HOME naming a file", ["a-file"], { COPILOT_HOME: "./a-file" }, false],
    ["~/.copilot", ["home/.copilot/"], {}, true],
  ],
  cursor: [
    ["a stray file named .cursor", ["home/.cursor"], {}, false],
    ["~/.cursor", ["home/.cursor/"], {}, true],
  ],
  cline: [
    ["a Documents directory alone", ["home/Documents/"], {}, false],
    ["~/Documents/Cline", ["home/Documents/Cline/"], {}, true],
    ["~/.cline", ["home/.cline/"], {}, true],
    ["~/Cline/Rules", ["home/Cline/Rules/"], {}, true],
    ["a Cline directory alone", ["home/Cline/"], {}, false],
    ["a stray file named .cline", ["home/.cline"], {}, false],
  ],
  opencode: [
    [
      "an opencode directory under $XDG_CONFIG_HOME",
      ["xdg/opencode/"],
      { XDG_CONFIG_HOME: "./xdg" },
      true,
    ],
    ["~/.config/opencode", ["home/.config/opencode/"], {}, true],
  ],
  dsh: [
    ["$DSH_HOME naming a file", ["elsewhere"], { DSH_HOME: "./elsewhere" }, false],
    ["$DSH_HOME naming a directory", ["dsh-home/"], { DSH_HOME: "./dsh-home" }, true],
    ["~/.dsh", ["home/.dsh/"], {}, true],
  ],
  devin: [["~/.config/devin", ["home/.config/devin/"], {}, true]],
  windsurf: [["~/.codeium/windsurf", ["home/.codeium/windsurf/"], {}, true]],
  zed: [
    ["a zed directory under $XDG_CONFIG_HOME", ["xdg/zed/"], { XDG_CONFIG_HOME: "./xdg" }, true],
    ["~/.config/zed", ["home/.config/zed/"], {}, true],
  ],
  amp: [["~/.config/amp", ["home/.config/amp/"], {}, true]],
  warp: [
    ["~/.warp", ["home/.warp/"], {}, true],
    ["~/.config/warp-terminal", ["home/.config/warp-terminal/"], {}, true],
    [
      "~/Library/Group Containers/2BBY89MBSN.dev.warp",
      ["home/Library/Group Containers/2BBY89MBSN.dev.warp/"],
      {},
      true,
    ],
  ],
  pi: [
    [
      "$PI_CODING_AGENT_DIR naming a directory",
      ["elsewhere/"],
      { PI_CODING_AGENT_DIR: "./elsewhere" },
      true,
    ],
    ["$PI_CODING_AGENT_DIR naming a missing path", [], { PI_CODING_AGENT_DIR: "./missing" }, false],
    ["$PI_CODING_AGENT_DIR naming a file", ["a-file"], { PI_CODING_AGENT_DIR: "./a-file" }, false],
    ["~/.pi/agent", ["home/.pi/agent/"], {}, true],
  ],
};

type InstallRow = [BuiltInHarnessId, string, boolean, string[], Record<string, string>];

const installRows: InstallRow[] = HARNESS_IDS.flatMap((id): InstallRow[] => [
  [id, "an empty home", false, [], {}],
  ...INSTALLS[id].map(
    ([label, entries, env, installed]): InstallRow => [id, label, installed, entries, env],
  ),
]);

test.each(installRows)(
  "%s detection with %s reads %p",
  async (id, _label, installed, entries, env) => {
    await withTempDir((dir) => {
      for (const entry of entries) make(dir, entry);
      const under = Object.fromEntries(
        Object.entries(env).map(([name, value]) => [
          name,
          value.startsWith("./") ? join(dir, value.slice("./".length)) : value,
        ]),
      );
      expect(
        definitionOf(id).detect({
          home: join(dir, "home"),
          projectRoot: null,
          cwd: join(dir, "home"),
          env: under,
        }),
      ).toBe(installed);
    });
  },
);

// A harness that reads only the first of several instruction files gets the block in that file:
// beside it the block would never load, and a file created beside the user's would silence
// theirs. Pi also reads the `.MD` spellings, which a case-insensitive filesystem cannot tell from
// these, so only the lower-case names are driven. Codex's blank-file rule is content-sensitive
// and stays in its own folder test.
const BLOCK_FILES: [BuiltInHarnessId, Scope, string[], string][] = [
  ["amp", "project", ["CLAUDE.md"], "CLAUDE.md"],
  ["amp", "project", ["AGENT.md", "CLAUDE.md"], "AGENT.md"],
  ["amp", "project", ["AGENTS.md", "AGENT.md", "CLAUDE.md"], "AGENTS.md"],
  ["warp", "project", ["AGENTS.md", "WARP.md"], "WARP.md"],
  ["zed", "project", [".rules", "AGENTS.md"], ".rules"],
  ["zed", "project", ["CLAUDE.md"], "CLAUDE.md"],
  ["zed", "project", ["AGENTS.md", "CLAUDE.md"], "AGENTS.md"],
  [
    "zed",
    "project",
    [".clinerules/", ".github/copilot-instructions.md", "GEMINI.md"],
    ".github/copilot-instructions.md",
  ],
  ...scopes.flatMap((scope): [BuiltInHarnessId, Scope, string[], string][] => [
    ["pi", scope, ["CLAUDE.md"], "CLAUDE.md"],
    ["pi", scope, ["CLAUDE.md", "AGENTS.md"], "AGENTS.md"],
    ["pi", scope, ["CLAUDE.md", "AGENTS.md", "AGENTS.override.md"], "AGENTS.override.md"],
  ]),
];

test.each(BLOCK_FILES)(
  "%s: the %s block goes into the file it reads first among %j",
  async (id, scope, present, expected) => {
    const target = definitionOf(id).targets[scope];
    if (target?.kind !== "shared-block") throw new Error(`${id} has no ${scope} shared block`);
    await withTempDir((dir) => {
      for (const entry of present) make(dir, entry);
      expect(sharedBlockFile(target, dir)).toBe(expected);
    });
  },
);
