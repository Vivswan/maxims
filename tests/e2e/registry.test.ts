// Fails if any shipped harness definition, present or future, stops installing through the
// bundle the way its declaration promises: a rule target that is missing, a symlink, or lacks
// its frontmatter; a registry with no handler or two; a hook file that is not there or not
// executable; a custom hook or config edit left half applied; or a remove that leaves the
// user's hand-formatted file changed by a byte. The rows are derived from the registry, so a new
// definition is covered without new test code, and a declared config fixture with no place to
// be seeded fails here rather than going untested.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sourceSlug } from "../../src/commands/shared/slug.ts";
import { targetPath } from "../../src/commands/shared/sources.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  HOOK_COMMAND,
  hookSpecFor,
  type RegistryHook,
  type Scope,
  scopeRoot,
} from "../../src/harnesses/contract.ts";
import { hasHook, hookPath } from "../../src/harnesses/hook-writer.ts";
import { HARNESSES } from "../../src/harnesses/registry.ts";
import type { Change } from "../../src/util/change.ts";
import { ExitCode } from "../../src/util/exit-codes.ts";
import { withTempDir } from "../shared/temp_dir.ts";
import {
  type Bundle,
  buildBundle,
  childEnv,
  type Home,
  makeHome,
  type Run,
  runMaxims,
} from "./binary.ts";
import { fixtureRepo, harnessFixture } from "./fixtures.ts";

let bundleDir = "";
let bundle: Bundle;

beforeAll(() => {
  const home = process.env.HOME;
  if (home === undefined) throw new Error("the test launcher must set HOME");
  bundleDir = mkdtempSync(join(home, "maxims-e2e-bundle-"));
  bundle = buildBundle(bundleDir);
});

afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true });
});

const SCOPES: Scope[] = ["global", "project"];
const SKILL_NAMES = 4;

function ok(run: Run): Run {
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: ExitCode.Ok, stderr: "" });
  return run;
}

function contextFor(home: Home): HarnessContext {
  return { home: home.root, projectRoot: home.project, env: childEnv(home) };
}

// Where a definition's hand-formatted fixture lives on a machine: its hook registry, else its
// MCP registry (the machine-wide one when the scope has none), else the file its quirk edits. A
// definition whose fixture fits none of these has no row to prove it survives, which the census
// below turns into a failure.
const QUIRK_FIXTURE_HOMES: Partial<
  Record<string, (def: HarnessDefinition, scope: Scope, ctx: HarnessContext) => string | null>
> = {
  dsh: (def, _scope, ctx) => join(scopeRoot(def, "global", ctx), "cordis.patch.yml"),
  opencode: (_def, scope, ctx) =>
    scope === "project" && ctx.projectRoot !== null
      ? join(ctx.projectRoot, "opencode.jsonc")
      : null,
};

function fixtureHome(def: HarnessDefinition, scope: Scope, ctx: HarnessContext): string | null {
  if (def.fixtures?.config === undefined) return null;
  if (hasHook(def, "registry")) return hookPath(def, scope, ctx);
  const mcp = def.mcp?.path(scope, ctx) ?? def.mcp?.path("global", ctx);
  if (mcp !== undefined && mcp !== null) return mcp;
  return QUIRK_FIXTURE_HOMES[def.id]?.(def, scope, ctx) ?? null;
}

type Seeded = { path: string; text: string };

function seedFixture(def: HarnessDefinition, scope: Scope, ctx: HarnessContext): Seeded | null {
  const path = fixtureHome(def, scope, ctx);
  const name = def.fixtures?.config;
  if (path === null || name === undefined) return null;
  const text = harnessFixture(def.id, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return { path, text };
}

// The config directory detection reads, and the folder a project rules directory must already
// have (a project that has no `.claude/` is not using Claude Code there).
function prepareRoots(def: HarnessDefinition, scope: Scope, ctx: HarnessContext): void {
  mkdirSync(scopeRoot(def, "global", ctx), { recursive: true });
  const target = def.targets[scope];
  if (target?.kind === "rules-dir") {
    const [folder] = target.dir.split("/");
    if (folder !== undefined)
      mkdirSync(join(scopeRoot(def, scope, ctx), folder), { recursive: true });
  }
}

type Handler = Record<string, unknown>;

function registryHandlers(hook: RegistryHook, text: string): Handler[] {
  let node: unknown = JSON.parse(text);
  for (const key of hook.eventPath) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return [];
    node = (node as Record<string, unknown>)[key];
  }
  if (!Array.isArray(node)) return [];
  const handlers = hook.grouped
    ? node.flatMap((group) => {
        const list = (group as { hooks?: unknown }).hooks;
        return Array.isArray(list) ? list : [];
      })
    : node;
  return handlers.filter(
    (handler): handler is Handler =>
      typeof handler === "object" && handler !== null && !Array.isArray(handler),
  );
}

function ourHandlers(hook: RegistryHook, text: string): Handler[] {
  return registryHandlers(hook, text).filter(
    (handler) => handler[hook.commandKey] === HOOK_COMMAND,
  );
}

// A plan the disk already carries out: every write finds its bytes in place, every delete finds
// nothing. A custom hook re-emits its file writes whenever it is wanted, so an empty plan is not
// how its convergence shows.
function carriedOut(change: Change): boolean {
  switch (change.kind) {
    case "write":
      return existsSync(change.path) && readFileSync(change.path, "utf8") === change.content;
    case "delete":
    case "unlink":
      return !existsSync(change.path);
    case "mkdir":
      return existsSync(change.path);
    case "symlink":
      return false;
  }
}

function satisfied(changes: readonly Change[]): boolean {
  return changes.every(carriedOut);
}

function regularFile(path: string): { file: boolean; link: boolean } {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  return { file: entry?.isFile() === true, link: entry?.isSymbolicLink() === true };
}

async function expectHookInstalled(
  def: HarnessDefinition,
  scope: Scope,
  ctx: HarnessContext,
): Promise<void> {
  const spec = hookSpecFor(def);
  if (hasHook(def, "registry")) {
    const path = hookPath(def, scope, ctx);
    expect(ourHandlers(def.hook, readFileSync(path, "utf8"))).toEqual([def.hook.handler(spec)]);
  } else if (hasHook(def, "file")) {
    const path = hookPath(def, scope, ctx);
    expect(readFileSync(path, "utf8")).toBe(def.hook.render(spec));
    // Windows keeps no execute bit, so only the bytes are judged there.
    if (process.platform !== "win32") {
      expect((statSync(path).mode & 0o111) !== 0).toBe(def.hook.executable);
    }
  } else if (hasHook(def, "custom")) {
    const plan = await def.hook.reconcile(scope, ctx, spec, true);
    expect(plan.length > 0 && satisfied(plan)).toBe(true);
  }
  if (def.configEdit !== undefined) expect(await def.configEdit(scope, ctx, true)).toEqual([]);
}

async function expectHookGone(
  def: HarnessDefinition,
  scope: Scope,
  ctx: HarnessContext,
  seeded: Seeded | null,
): Promise<void> {
  const spec = hookSpecFor(def);
  if (hasHook(def, "registry")) {
    const path = hookPath(def, scope, ctx);
    expect(readFileSync(path, "utf8")).toBe(seeded?.path === path ? seeded.text : "{}\n");
  } else if (hasHook(def, "file")) {
    expect(existsSync(hookPath(def, scope, ctx))).toBe(false);
  } else if (hasHook(def, "custom")) {
    expect(satisfied(await def.hook.reconcile(scope, ctx, spec, false))).toBe(true);
  }
  if (def.configEdit !== undefined) expect(await def.configEdit(scope, ctx, false)).toEqual([]);
}

type Row = [id: string, scope: Scope, def: HarnessDefinition];

const rows: Row[] = HARNESSES.flatMap((def) =>
  SCOPES.filter((scope) => def.targets[scope] !== null).map((scope): Row => [def.id, scope, def]),
);

const missingScope: Row[] = HARNESSES.flatMap((def) =>
  SCOPES.filter((scope) => def.targets[scope] === null).map((scope): Row => [def.id, scope, def]),
);

test("every declared config fixture has a place on disk where a row seeds it", () => {
  const homeless = HARNESSES.filter(
    (def) =>
      def.fixtures?.config !== undefined &&
      SCOPES.every(
        (scope) =>
          def.targets[scope] === null ||
          fixtureHome(def, scope, {
            home: "/home/user",
            projectRoot: "/home/user/project",
            env: {},
          }) === null,
      ),
  ).map((def) => def.id);
  expect(homeless).toEqual([]);
});

describe.each(rows)("%s at the %s scope", (_id, scope, def) => {
  test("add installs the target and the hook; remove takes both back byte for byte", async () => {
    await withTempDir(async (dir) => {
      const home = makeHome(dir);
      const ctx = contextFor(home);
      prepareRoots(def, scope, ctx);
      const seeded = seedFixture(def, scope, ctx);
      const source = fixtureRepo(dir, "skills");
      const slug = sourceSlug({ type: "local", path: source });
      const target = targetPath(def, { scope }, ctx, slug);
      if (target === null) throw new Error("the row was derived from a non-null target");
      const scopeFlag = scope === "global" ? "-g" : "-p";
      const argv = ["add", source, scopeFlag, "--rule", "--add-hook", "-a", def.id, "-y"];
      ok(await runMaxims(bundle, home, argv, { cwd: home.project }));

      expect(regularFile(target)).toEqual({ file: true, link: false });
      const text = readFileSync(target, "utf8");
      const declared = def.targets[scope];
      const preamble = declared?.kind === "rules-dir" ? (declared.frontmatter?.({}) ?? "") : "";
      expect(text.startsWith(preamble)).toBe(true);
      expect(text).toContain(`<!-- maxims:begin ${source} sha=`);
      expect(text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(SKILL_NAMES);
      await expectHookInstalled(def, scope, ctx);
      // A fixture that is no hook's registry and no quirk's file (an MCP config) is never touched.
      const hookArtifact =
        hasHook(def, "registry") || hasHook(def, "custom") || def.configEdit !== undefined;
      if (seeded !== null && !hookArtifact)
        expect(readFileSync(seeded.path, "utf8")).toBe(seeded.text);

      ok(await runMaxims(bundle, home, ["remove", source, "-y"], { cwd: home.project }));
      expect(existsSync(target)).toBe(false);
      await expectHookGone(def, scope, ctx, seeded);
      if (seeded !== null) expect(readFileSync(seeded.path, "utf8")).toBe(seeded.text);
    });
  });
});

describe.each(missingScope)("%s has no %s target", (_id, scope, def) => {
  test("an install there is warned about and skipped", async () => {
    await withTempDir(async (dir) => {
      const home = makeHome(dir);
      const ctx = contextFor(home);
      prepareRoots(def, scope, ctx);
      const source = fixtureRepo(dir, "skills");
      const scopeFlag = scope === "global" ? "-g" : "-p";
      const run = await runMaxims(
        bundle,
        home,
        ["add", source, scopeFlag, "--rule", "-a", def.id, "-y"],
        {
          cwd: home.project,
        },
      );
      expect(run.stdout).toContain(`!  ${def.id} has no ${scope} target; skipped\n`);
      const root = scopeRoot(def, scope, ctx);
      const other = def.targets[scope === "global" ? "project" : "global"];
      if (other?.kind === "rules-dir") expect(existsSync(join(root, other.dir))).toBe(false);
      else if (other !== null) expect(existsSync(join(root, other.file))).toBe(false);
    });
  });
});
