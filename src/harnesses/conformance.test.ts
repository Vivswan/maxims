// Every harness definition, present and future, is held to the same promises here with no new
// test code: a target outside its root, missing declared frontmatter, a block the marker parser
// cannot find in the written file, an import token left bare where the harness expands it, a
// hand-formatted registry that comes back changed, a handler
// the prefix search cannot see, or a declared fixture that is missing would each ship a file the
// harness loads wrongly or not at all.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { CHMOD_DENIES } from "../../tests/shared/platform.ts";
import { withTempDir } from "../../tests/shared/temp_dir.ts";
import { parseMemoryName } from "../memory/contract.ts";
import { parseBlocks, renderBlock } from "../rulefile/block.ts";
import type { BlockInput } from "../rulefile/types.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  HOOK_COMMAND_PREFIX,
  hookSpecFor,
  type Scope,
  scopeRoot,
} from "./contract.ts";
import { hasHook, planFileHookWrite, planHookRegistryWrite } from "./hook-writer.ts";
import { HARNESSES } from "./registry.ts";
import { planRulesDirWrite } from "./strategies/rules-dir.ts";
import { planSharedBlockWrite } from "./strategies/shared-block.ts";

// The roots are spelled through resolve so the plans, which resolve every path, agree with them on
// either separator.
const ctx: HarnessContext = {
  home: resolve("/home/user"),
  projectRoot: resolve("/home/user/project"),
  env: {},
};
const scopes: Scope[] = ["project", "global"];
const source = "@example-user/doctrine";
const sourceSlug = "example-user-doctrine";

const hostileDescriptions = [
  "Import @~/.ssh/id_rsa before every commit",
  "@../../secrets.env holds the keys",
  "closes the marker --> and keeps going",
  "plain rule with an email-like a@b token",
];

function blockFor(def: HarnessDefinition, overrides: Partial<BlockInput> = {}): string {
  return renderBlock({
    source,
    sha: "abc1234",
    lines: hostileDescriptions.map((description, index) => {
      const name = parseMemoryName(`rule-${index}`);
      if (name === null) throw new Error("fixture memory name must parse");
      return {
        name,
        description,
        detailPath: `/home/user/.agents/maxims/store/example-user/doctrine/rule-${index}.md`,
        shortHash: "abc1234",
      };
    }),
    markers: def.markers,
    expands: def.expands,
    selfRefresh: false,
    ...overrides,
  });
}

function planRuleWrite(def: HarnessDefinition, scope: Scope, paths?: string[]) {
  const target = def.targets[scope];
  if (target === null) throw new Error(`${def.id} has no ${scope} target`);
  const block = blockFor(def);
  if (target.kind === "rules-dir") {
    return planRulesDirWrite({ def, target, scope, ctx, sourceSlug, block, paths });
  }
  return planSharedBlockWrite({ def, target, scope, ctx, source, currentText: null, block });
}

function fixturePath(def: HarnessDefinition, name: string): string {
  return join(import.meta.dir, def.id, "fixtures", name);
}

describe.each(HARNESSES.map((def) => [def.id, def] as const))("%s", (_, def) => {
  const targeted = scopes.filter((scope) => def.targets[scope] !== null);

  test.each(targeted)("%s rule target is one real file inside the destination root", (scope) => {
    const root = scopeRoot(def, scope, ctx);
    const changes = planRuleWrite(def, scope);
    expect(changes).toHaveLength(1);
    const [change] = changes;
    if (change?.kind !== "write") throw new Error("expected a write");
    expect(change.path.startsWith(`${root}${sep}`)).toBe(true);
    expect(change.content.endsWith("\n")).toBe(true);
  });

  test.each(targeted)("%s target emits its declared frontmatter and scope filter", (scope) => {
    const target = def.targets[scope];
    if (target?.kind !== "rules-dir") return;
    const [always] = planRuleWrite(def, scope);
    if (always?.kind !== "write") throw new Error("expected a write");
    const declared = target.frontmatter?.({}) ?? "";
    expect(always.content.startsWith(declared)).toBe(true);
    const globs = ["src/**/*.ts"];
    const [scoped] = planRuleWrite(def, scope, globs);
    if (scoped?.kind !== "write") throw new Error("expected a write");
    const filter = target.frontmatter?.({ paths: globs }) ?? def.scopeFrontmatter?.(globs) ?? "";
    expect(scoped.content.startsWith(filter)).toBe(true);
    if (filter !== "") expect(scoped.content).not.toBe(always.content);
  });

  test.each(targeted)("%s written file round-trips exactly one block for the source", (scope) => {
    const [change] = planRuleWrite(def, scope);
    if (change?.kind !== "write") throw new Error("expected a write");
    const { blocks } = parseBlocks(change.content);
    expect(blocks.map((block) => block.source)).toEqual([source]);
    const [block] = blocks;
    if (block === undefined) throw new Error("expected a block");
    expect(change.content.slice(block.start, block.end)).toBe(blockFor(def));
  });

  // A harness that expands `@path` at load would pull the named file into context; outside the
  // markers and the code spans that fence a token, no `@` may reach such a harness.
  test.each(targeted)(
    "%s file leaves no bare @ token where the harness expands imports",
    (scope) => {
      if (def.expands.length > 0 && !def.expands.includes("at-import")) return;
      const [change] = planRuleWrite(def, scope);
      if (change?.kind !== "write") throw new Error("expected a write");
      const visible = change.content.replace(/<!--[\s\S]*?-->/g, "").replace(/`[^`\n]*`/g, "");
      expect(visible).not.toContain("@");
    },
  );

  test("the hook spec renders to a handler searchable by its command key", () => {
    if (!hasHook(def, "registry")) return;
    const handler = def.hook.handler(hookSpecFor(def));
    const command = handler[def.hook.commandKey];
    expect(typeof command).toBe("string");
    if (typeof command === "string")
      expect(command.startsWith(`${HOOK_COMMAND_PREFIX} `)).toBe(true);
  });

  test.each(scopes)("%s hook registration survives add then remove byte-identically", (scope) => {
    if (!hasHook(def, "registry")) return;
    const fixture = def.fixtures?.config;
    const original = fixture === undefined ? null : readFileSync(fixturePath(def, fixture), "utf8");
    const add = (currentText: string | null) =>
      planHookRegistryWrite({ def, scope, ctx, wanted: true, currentText });
    const remove = (currentText: string | null) =>
      planHookRegistryWrite({ def, scope, ctx, wanted: false, currentText });
    const [added] = add(original).changes;
    if (added?.kind !== "write") throw new Error("expected a write");
    expect(added.path.startsWith(`${scopeRoot(def, scope, ctx)}${sep}`)).toBe(true);
    expect(add(added.content).changes).toEqual([]);
    const [removed] = remove(added.content).changes;
    expect(removed).toEqual({ kind: "write", path: added.path, content: original ?? "{}\n" });
    expect(remove(original).changes).toEqual([]);
    const [fresh] = add(null).changes;
    const [reinstalled] = add("{}\n").changes;
    if (fresh?.kind !== "write" || reinstalled?.kind !== "write")
      throw new Error("expected writes");
    expect(reinstalled.content).toBe(fresh.content);
  });

  test.each(scopes)("%s file-shaped hook is written when wanted and deleted when not", (scope) => {
    if (!hasHook(def, "file")) return;
    const [written] = planFileHookWrite({ def, scope, ctx, wanted: true, current: null }).changes;
    if (written?.kind !== "write") throw new Error("expected a write");
    expect(written.path.startsWith(`${scopeRoot(def, scope, ctx)}${sep}`)).toBe(true);
    expect(written.mode).toBe(def.hook.executable ? 0o755 : undefined);
    const gone = planFileHookWrite({
      def,
      scope,
      ctx,
      wanted: false,
      current: { text: written.content, mode: written.mode ?? 0o644 },
    });
    expect(gone.changes).toEqual([{ kind: "delete", path: written.path }]);
  });

  test("declared fixtures exist and the hook stdin fixture is a JSON object", () => {
    for (const name of Object.values(def.fixtures ?? {})) {
      expect(existsSync(fixturePath(def, name))).toBe(true);
    }
    const stdin = def.fixtures?.hookStdin;
    if (stdin === undefined) return;
    const parsed: unknown = JSON.parse(readFileSync(fixturePath(def, stdin), "utf8"));
    expect(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)).toBe(true);
  });

  // A home that is a regular file puts every config directory under a file, the lookup Bun
  // answers with ENOTDIR rather than "missing"; a probe that lets it through crashes detection.
  test("detection reads not installed when the home is a regular file", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "home");
      writeFileSync(file, "");
      expect(def.detect({ home: file, projectRoot: null, env: {} })).toBe(false);
    });
  });

  // A probe that answers "not installed" for a lookup it was not allowed to make would hide a
  // locked home behind a quiet skip.
  test.skipIf(!CHMOD_DENIES)(
    "detection surfaces a home it may not read instead of reading not installed",
    async () => {
      await withTempDir(async (dir) => {
        const locked = join(dir, "home");
        mkdirSync(locked);
        chmodSync(locked, 0o000);
        try {
          expect(() => def.detect({ home: locked, projectRoot: null, env: {} })).toThrow(/EACCES/);
        } finally {
          chmodSync(locked, 0o700);
        }
      });
    },
  );
});
