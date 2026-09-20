import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { validateMemoryFiles } from "../../src/commands/shared/memories.ts";
import type { EngineIo, SymlinkSupport } from "../../src/commands/types.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  type Scope,
  scopeRoot,
} from "../../src/harnesses/contract.ts";
import { contentHashOf, type MemoryName, parseMemoryName } from "../../src/memory/contract.ts";
import type { FetchResult, ResolverFor, SourceResolver } from "../../src/sources/contract.ts";
import { FetchFailure, type FetchFailureKind } from "../../src/sources/github/ladder.ts";
import { createLocalResolver } from "../../src/sources/local.ts";
import { hashFiles, readMemoryTree } from "../../src/sources/tree.ts";
import {
  canonicalSourceKey,
  type Fetched,
  type GitSha,
  parseGitSha,
  type SourceEntry,
  type SourceFrom,
  type SourceIntent,
  type State,
} from "../../src/state/schema.ts";
import { serializeState } from "../../src/state/store.ts";
import { assertInsideRoot, sha256 } from "../../src/util/fs.ts";
import { homePaths, storePathFor } from "../../src/util/home.ts";

export const FIXTURE_DIR = ".fixture";

export function memoryName(candidate: string): MemoryName {
  const name = parseMemoryName(candidate);
  if (name === null) throw new Error(`${candidate} is not a memory name`);
  return name;
}

export function gitSha(candidate: string): GitSha {
  const sha = parseGitSha(candidate);
  if (sha === null) throw new Error(`${candidate} is not a git sha`);
  return sha;
}

// The commit id a remote fixture reports for a directory: cut from the tree hash, so facts
// seeded from a directory and an unscripted fake fetch of the same directory agree.
export function fixtureGitSha(treeSha: string): GitSha {
  return gitSha(treeSha.slice("sha256:".length, "sha256:".length + 40));
}

// Two definitions with the two writing strategies, whose files all sit under `.fixture/` in the
// user home or the project. They carry real harness ids so state accepts them.
export const rulesDirHarness: HarnessDefinition = {
  id: "claude-code",
  displayName: "Fixture Rules",
  tier: 1,
  targets: {
    project: {
      kind: "rules-dir",
      dir: join(FIXTURE_DIR, "rules"),
      fileName: (slug) => `maxims-${slug}.md`,
    },
    global: {
      kind: "rules-dir",
      dir: join(FIXTURE_DIR, "rules"),
      fileName: (slug) => `maxims-${slug}.md`,
    },
  },
  bodiesDir: (scope, ctx) =>
    scope === "project" && ctx.projectRoot !== null
      ? join(ctx.projectRoot, ".agents", "memories")
      : null,
  hook: {
    kind: "registry",
    path: (scope, ctx) => join(scopeRoot({}, scope, ctx), FIXTURE_DIR, "settings.json"),
    format: "json",
    eventPath: ["hooks", "SessionStart"],
    grouped: true,
    handler: (spec) => ({ type: "command", command: [spec.command, ...spec.args].join(" ") }),
    commandKey: "command",
    stdout: "plain",
    async: true,
  },
  markers: "stripped",
  expands: ["at-import"],
  detect: () => true,
  verifiedAgainst: { url: "https://example.com/fixture", date: "2026-01-01" },
};

export const sharedBlockHarness: HarnessDefinition = {
  id: "codex",
  displayName: "Fixture Shared",
  tier: 1,
  targets: {
    project: { kind: "shared-block", file: "FIXTURE.md" },
    global: { kind: "shared-block", file: join(FIXTURE_DIR, "FIXTURE.md") },
  },
  bodiesDir: (scope, ctx) =>
    scope === "project" && ctx.projectRoot !== null
      ? join(ctx.projectRoot, ".agents", "memories")
      : null,
  hook: {
    kind: "file",
    path: (scope, ctx) => join(scopeRoot({}, scope, ctx), FIXTURE_DIR, "hooks", "start"),
    render: (spec) => `#!/bin/sh\n${[spec.command, ...spec.args].join(" ")}\n`,
    executable: true,
    stdout: "json:additionalContext",
  },
  markers: "counted",
  expands: [],
  detect: () => true,
  verifiedAgainst: { url: "https://example.com/fixture", date: "2026-01-01" },
};

export const FIXTURE_CONFIG_CONTENT = '{"instructions":["rules"]}\n';

// The rules-dir fixture with a config entry its rules directory needs, reconciled like a hook.
export const configEditHarness: HarnessDefinition = {
  ...rulesDirHarness,
  configEdit: async (_scope, ctx, wanted) => {
    const path = assertInsideRoot(ctx.home, join(ctx.home, FIXTURE_DIR, "config.json"));
    return wanted
      ? [{ kind: "write", path, content: FIXTURE_CONFIG_CONTENT }]
      : [{ kind: "delete", path }];
  },
};

export function fixtureRoot(scope: Scope, ctx: HarnessContext): string {
  return join(scopeRoot({}, scope, ctx), FIXTURE_DIR);
}

export type MemorySpec = {
  description: string;
  body?: string;
  internal?: boolean;
};

// Writes `memories/<name>.md` files that pass the contract, and returns the source root.
export function writeSource(root: string, memories: Record<string, MemorySpec>): string {
  mkdirSync(join(root, "memories"), { recursive: true });
  for (const [name, spec] of Object.entries(memories)) {
    writeFileSync(join(root, "memories", `${name}.md`), memoryFile(name, spec));
  }
  return root;
}

export function memoryFile(name: string, spec: MemorySpec): string {
  const internal = spec.internal === true ? "\n  internal: true" : "";
  return `---\nname: ${name}\ndescription: ${spec.description}\nmetadata:\n  node_type: memory${internal}\n---\n\n${spec.body ?? `Body of ${name}.`}\n`;
}

export type FetchBehaviour =
  | { kind: "dir"; dir: string; sha?: string }
  | { kind: "fail"; failure: FetchFailureKind; retryAfterSeconds?: number }
  | { kind: "throw"; error: Error };

export type FakeResolvers = {
  resolvers: ResolverFor;
  calls: string[];
  set(from: SourceFrom, behaviour: FetchBehaviour): void;
};

// A resolver per canonical key: serves a directory as the remote tree (sha = the tree hash, or a
// fixed one), fails with a classified ladder failure, or throws. A local source with no scripted
// behaviour gets the real local resolver.
export function fakeResolvers(): FakeResolvers {
  const behaviours = new Map<string, FetchBehaviour>();
  const calls: string[] = [];
  const local = createLocalResolver(() => undefined);
  const resolvers: ResolverFor = <F extends SourceFrom>(from: F): SourceResolver<F> => {
    const key = canonicalSourceKey(from);
    const behaviour = behaviours.get(key);
    if (behaviour === undefined && from.type === "local") {
      return {
        fetch: (_target, opts) => {
          calls.push(`fetch ${key}`);
          return local.fetch(from, opts);
        },
      };
    }
    const act = async <T>(
      run: (dir: string, sha: string | undefined) => Promise<T>,
    ): Promise<T> => {
      if (behaviour === undefined) throw new FetchFailure("missing", `no fixture for ${key}`);
      if (behaviour.kind === "throw") throw behaviour.error;
      if (behaviour.kind === "fail") {
        throw new FetchFailure(
          behaviour.failure,
          `scripted ${behaviour.failure}`,
          behaviour.retryAfterSeconds,
        );
      }
      return run(behaviour.dir, behaviour.sha);
    };
    // A scripted directory stands for a remote's tree, so it reports a commit id; a local
    // directory reports its tree hash like the real local resolver.
    const shaOf = (treeSha: string, scripted: string | undefined): string =>
      scripted ?? (from.type === "local" ? treeSha : fixtureGitSha(treeSha));
    return {
      resolveRef: async () => {
        calls.push(`resolveRef ${key}`);
        return act(async (dir, sha) => shaOf((await treeOf(dir)).sha, sha));
      },
      fetch: async (_target, opts): Promise<FetchResult> => {
        calls.push(`fetch ${key}`);
        return act(async (dir, sha) => {
          const tree = await treeOf(dir, opts.memoryPath, opts.fullDepth);
          return { sha: shaOf(tree.sha, sha), memoryPath: opts.memoryPath, files: tree.files };
        });
      },
    };
  };
  return {
    resolvers,
    calls,
    set: (from, behaviour) => behaviours.set(canonicalSourceKey(from), behaviour),
  };
}

async function treeOf(dir: string, memoryPath = "memories", fullDepth = false) {
  const tree = await readMemoryTree(dir, { memoryPath, fullDepth }, () => undefined);
  return { sha: hashFiles(tree.files), files: tree.files };
}

export type FakeIo = EngineIo & {
  out: string[];
  err: string[];
  stdin: string | null;
  clock: { now: Date };
  symlink: SymlinkSupport;
};

export type FakeIoOptions = {
  home: string;
  userHome: string;
  cwd: string;
  harnesses?: readonly HarnessDefinition[];
  resolvers?: ResolverFor;
  now?: Date;
  env?: Record<string, string | undefined>;
};

export function fakeIo(options: FakeIoOptions): FakeIo {
  const io: FakeIo = {
    out: [],
    err: [],
    stdin: null,
    clock: { now: options.now ?? new Date("2026-09-20T12:00:00.000Z") },
    symlink: { ok: true },
    stdout: (text) => io.out.push(text),
    stderr: (text) => io.err.push(text),
    resolvers: options.resolvers ?? fakeResolvers().resolvers,
    harnesses: options.harnesses ?? [rulesDirHarness, sharedBlockHarness],
    now: () => io.clock.now,
    env: { HOME: options.userHome, MAXIMS_HOME: options.home, ...options.env },
    cwd: options.cwd,
    readStdin: async () => io.stdin,
    symlinkSupport: async () => io.symlink,
  };
  return io;
}

export const ADDED_AT = "2026-08-01T00:00:00.000Z";

export type IntentOverrides = Partial<Omit<SourceIntent, "from">>;

function baseIntent(overrides: IntentOverrides): Omit<SourceIntent, "from"> {
  return {
    select: "*",
    rename: {},
    rule: true,
    destination: { scope: "global" },
    copy: false,
    auth: false,
    harnesses: ["claude-code"],
    memoryPath: "memories",
    fullDepth: false,
    ...overrides,
  };
}

// The entry variant follows `from`: a live directory records no fetch, a copied one or a remote
// starts with none.
export function entryFor(from: SourceFrom, overrides: IntentOverrides = {}): SourceEntry {
  const base = baseIntent(overrides);
  if (from.type === "local") {
    if (from.live === true) return { intent: { ...base, from }, addedAt: ADDED_AT };
    return { intent: { ...base, from }, addedAt: ADDED_AT };
  }
  return { intent: { ...base, from }, addedAt: ADDED_AT };
}

export function stateWith(
  entries: Record<string, SourceEntry>,
  hooks: State["hooks"] = [],
  disabled?: State["disabled"],
): State {
  const state: State = { version: 1, writtenBy: "maxims@0.0.0-fixture", hooks, sources: entries };
  if (disabled !== undefined) state.disabled = disabled;
  return state;
}

export function writeState(home: string, state: State): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(homePaths(home).state, serializeState(state));
}

export function readStateFile(home: string): State {
  return JSON.parse(readFileSync(homePaths(home).state, "utf8"));
}

export type RemoteFrom = Extract<SourceFrom, { ref: string }>;

export function githubFrom(repo: string, ref = "HEAD"): RemoteFrom {
  return { type: "github", repo, ref };
}

export function localFrom(path: string, live = false): SourceFrom {
  return live ? { type: "local", path, live: true } : { type: "local", path };
}

// A digest of every entry under `dir`: a regular file by its bytes, a symlink by its target text
// (dangling or not), a directory by its listing, so a before-and-after comparison sees any
// byte, link or entry that changed.
export function treeDigest(dir: string): string {
  const entries: string[] = [];
  const walk = (current: string, rel: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const relPath = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) entries.push(`${relPath} -> ${readlinkSync(path)}`);
      else if (stat.isDirectory()) {
        entries.push(`${relPath}/`);
        walk(path, relPath);
      } else entries.push(`${relPath}\0${sha256(readFileSync(path))}`);
    }
  };
  walk(dir, "");
  return sha256(entries.join("\n"));
}

export function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

// The record a remote source carries; every fixture that seeds fetch facts is a GitHub source.
export type FetchedFacts = Extract<Fetched, { sha: GitSha }>;

// The fetch record a real fetch of `dir` would have written at `at`, with an optional failure.
export async function fetchedFacts(
  dir: string,
  at: string,
  lastError: FetchedFacts["lastError"] = null,
  sha?: string,
): Promise<FetchedFacts> {
  const tree = await treeOf(dir);
  const { memories } = validateMemoryFiles(tree.files);
  return {
    at,
    sha: sha === undefined ? fixtureGitSha(tree.sha) : gitSha(sha),
    memoryPath: "memories",
    memories: Object.fromEntries(
      memories.map((memory) => [
        memory.memory.name,
        {
          content: memory.memory.contentHash,
          description: contentHashOf(memory.memory.description),
        },
      ]),
    ),
    lastError,
  };
}

// Puts a copy of `dir` where the store would hold the source, as an earlier fetch would have.
export function seedStore(home: string, from: SourceFrom, dir: string): string {
  const entry = storePathFor(home, from);
  cpSync(dir, entry, { recursive: true });
  return entry;
}

export function fetchedEntry(
  from: RemoteFrom,
  fetched: FetchedFacts,
  overrides: IntentOverrides = {},
): SourceEntry {
  return { intent: { ...baseIntent(overrides), from }, addedAt: ADDED_AT, fetched };
}
