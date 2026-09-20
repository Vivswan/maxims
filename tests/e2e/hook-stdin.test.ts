// Fails if a hook run of the bundle stops speaking each harness's stdout protocol: a plain line
// where Gemini demands one JSON object, a JSON envelope where Claude Code reads plain text, a
// stray byte for a harness that reads nothing, or a run that blocks on a pipe the harness never
// closes. The unit tests render the envelope from a variant; only this file proves the variant
// is chosen from the bytes a real harness writes to stdin and reaches stdout through node.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HarnessDefinition, HookStdout } from "../../src/harnesses/contract.ts";
import { HARNESSES } from "../../src/harnesses/registry.ts";
import { parseState, type SourceEntry, type State } from "../../src/state/schema.ts";
import { serializeState } from "../../src/state/store.ts";
import { ExitCode } from "../../src/util/exit-codes.ts";
import { homePaths } from "../../src/util/home.ts";
import { type Bundle, buildBundle, type Home, makeHome, runMaxims } from "./binary.ts";
import { fixtureRepo, harnessFixture, hookPayload } from "./fixtures.ts";

const GOLDEN = resolve(import.meta.dir, "..", "fixtures", "golden");
const LAST_GOOD = "2026-01-01T00:00:00.000Z";

let bundleDir = "";
let bundle: Bundle;
let scratch = "";
let home: Home;
let source = "";

// One installed source whose last refresh failed and whose directory is gone, settled by one
// manual sync: every hook run after it finds the failure inside its retry window, fetches
// nothing, and has exactly one line to say.
beforeAll(async () => {
  const launcherHome = process.env.HOME;
  if (launcherHome === undefined) throw new Error("the test launcher must set HOME");
  bundleDir = mkdtempSync(join(launcherHome, "maxims-e2e-bundle-"));
  bundle = buildBundle(bundleDir);
  scratch = mkdtempSync(join(launcherHome, "maxims-fixture-"));
  home = makeHome(scratch);
  mkdirSync(join(home.root, ".claude"));
  source = fixtureRepo(scratch, "skills");
  const add = await runMaxims(bundle, home, [
    "add",
    source,
    "-g",
    "--rule",
    "-a",
    "claude-code",
    "-y",
  ]);
  if (add.code !== ExitCode.Ok) throw new Error(`add exited ${add.code}: ${add.stderr}`);
  const statePath = homePaths(home.maximsHome).state;
  const parsed = parseState(JSON.parse(readFileSync(statePath, "utf8")));
  if (parsed.ok !== "parsed") throw new Error("state must parse after add");
  const entry = parsed.state.sources[source];
  if (entry === undefined || !("fetched" in entry) || entry.fetched === undefined) {
    throw new Error("expected a fetched entry");
  }
  const failed: SourceEntry = {
    ...entry,
    fetched: {
      ...entry.fetched,
      at: LAST_GOOD,
      lastError: { kind: "missing", message: "gone", at: LAST_GOOD },
    },
  } as SourceEntry;
  const state: State = { ...parsed.state, sources: { [source]: failed } };
  writeFileSync(statePath, serializeState(state));
  renameSync(source, `${source}.gone`);
  const settle = await runMaxims(bundle, home, ["sync"]);
  if (settle.code !== ExitCode.SourceUnresolvable) {
    throw new Error(`the settling sync exited ${settle.code}, not 2: ${settle.stderr}`);
  }
});

afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

function goldenName(variant: HookStdout): string {
  return `hook-stdout-${variant.replace(":", "-")}.txt`;
}

// A file hook or a registry hook declares how its harness reads stdout; a custom hook and a
// harness with no hook have no channel, so the run stays silent whatever stdin says.
function variantOf(def: HarnessDefinition): HookStdout | "none" {
  return def.hook.kind === "registry" || def.hook.kind === "file" ? def.hook.stdout : "none";
}

type Row = [label: string, variant: HookStdout, stdin: string | "open" | undefined];

const rows: Row[] = [
  ...HARNESSES.flatMap((def): Row[] => {
    const fixture = def.fixtures?.hookStdin;
    if (fixture === undefined) return [];
    return [[def.id, variantOf(def), harnessFixture(def.id, fixture)]];
  }),
  ["an empty JSON object", "none", "{}"],
  ["a pipe that never closes", "plain", "open"],
  ["no stdin at all", "plain", undefined],
];

// MAXIMS_UPDATE_GOLDEN=1 rewrites the fixtures from the current output; the diff is then reviewed
// like any other change to what a harness receives.
test.each(rows)("stdin from %s yields the %s shape on stdout", async (_label, variant, stdin) => {
  rmSync(homePaths(home.maximsHome).lastSync, { force: true });
  const started = Date.now();
  const payload = stdin === undefined || stdin === "open" ? stdin : hookPayload(stdin, home);
  const run = await runMaxims(
    bundle,
    home,
    ["sync", "--quiet"],
    payload === undefined ? {} : { stdin: payload },
  );
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: ExitCode.Ok, stderr: "" });
  expect(Date.now() - started).toBeLessThan(5000);
  // A JSON envelope carries the path escaped, so both spellings stand in for the placeholder.
  const escaped = JSON.stringify(source).slice(1, -1);
  const actual = run.stdout.replaceAll(escaped, "<SOURCE>").replaceAll(source, "<SOURCE>");
  if (variant === "none") {
    expect(actual).toBe("");
    return;
  }
  const golden = join(GOLDEN, goldenName(variant));
  if (process.env.MAXIMS_UPDATE_GOLDEN === "1") writeFileSync(golden, actual);
  expect(actual).toBe(readFileSync(golden, "utf8"));
});
