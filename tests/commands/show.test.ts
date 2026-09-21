// What would drift silently: a `show` that reads a harness's copy instead of the store (a body
// the user edited in place would print as installed), one that quarantines or migrates a state
// file it only meant to read, a bare name two sources provide that silently picks one, a scope
// flag or `--source` that stops narrowing, a disabled or held memory printed as live, or a
// `--json` document whose fields drift from the frame's rows.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShownMemory } from "../../src/commands/show.ts";
import { homePaths } from "../../src/util/home.ts";
import {
  FIXTURES,
  runCli,
  type Scenario,
  type ScenarioOptions,
  snapshot,
  withScenario,
  writeState,
} from "../cli/harness.ts";
import {
  daysAgo,
  fetchedEntry,
  fetchedFacts,
  githubFrom,
  gitSha,
  memoryName,
  seedStore,
  stateWith,
} from "../engine/harness.ts";

const SKILLS = join(FIXTURES, "skills");
const NOW = new Date("2026-09-20T12:00:00.000Z");
const NAME = memoryName("skip-unfit-skills");
const FILE = readFileSync(join(SKILLS, "memories", `${NAME}.md`), "utf8");

type Document = ShownMemory & { ok: boolean; kind: "memory"; notices: string[] };

async function add(scenario: Scenario, source: string, ...flags: string[]): Promise<void> {
  const run = await runCli(scenario, ["add", source, "-a", "codex", ...flags]);
  expect(run.code).toBe(0);
}

async function shown(scenario: Scenario, ...argv: string[]): Promise<Document> {
  const run = await runCli(scenario, ["show", ...argv, "--json"]);
  expect([run.code, run.stderr]).toEqual([0, ""]);
  return JSON.parse(run.stdout) as Document;
}

const bothRepos: ScenarioOptions = { github: { "a/b": SKILLS, "a/c": SKILLS } };

describe("show", () => {
  test("prints the store copy verbatim after the facts, and the same facts under --json", async () => {
    await withScenario(bothRepos, async (scenario) => {
      await add(scenario, "@a/b", "-g", "--rule");
      const before = await snapshot(scenario.root);
      const run = await runCli(scenario, ["show", NAME]);
      expect([run.code, run.stderr]).toEqual([0, ""]);
      const [frame, body] = splitAtBody(run.stdout);
      expect(body).toBe(FILE);
      const storeFile = join(homePaths(scenario.home).store, "a", "b", "memories", `${NAME}.md`);
      expect(frame).toMatch(
        new RegExp(
          [
            "^\\|",
            `o  ${NAME}`,
            "   source: @a/b",
            "   revision: [0-9a-f]{7}",
            "   disabled: no",
            "   held: no",
            `   rule: - ${regexLiteral(FILE.split("\n")[2]?.slice("description: ".length) ?? "")} \\(detail: ${regexLiteral(storeFile)}, [0-9a-f]{7}\\)`,
            "\\|",
            "$",
          ].join("\\n"),
        ),
      );
      const document = await shown(scenario, NAME);
      expect(document).toEqual({
        ok: true,
        kind: "memory",
        name: NAME,
        upstreamName: NAME,
        source: "@a/b",
        sha: document.sha,
        disabled: false,
        held: false,
        ruleLine: document.ruleLine,
        body: FILE,
        notices: [],
      });
      expect(document.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(frame).toContain(`   rule: ${document.ruleLine}\n`);
      // Two reads later the home holds exactly what the add left: no lock, no log line, no stamp.
      expect(await snapshot(scenario.root)).toBe(before);
    });
  });

  test("a source added without --rule shows no rule line, and a renamed memory its upstream name", async () => {
    await withScenario(bothRepos, async (scenario) => {
      await add(scenario, "@a/b", "-g", "--rename", `${NAME}=skip-unfit`);
      const document = await shown(scenario, "skip-unfit");
      expect(document).toMatchObject({ name: "skip-unfit", upstreamName: NAME, ruleLine: null });
      const run = await runCli(scenario, ["show", "skip-unfit"]);
      expect(run.stdout).toContain(`   source: @a/b (upstream name ${NAME})\n`);
      expect(run.stdout).toContain("   rule: none (the source publishes no rule lines)\n");
      const upstream = await runCli(scenario, ["show", NAME]);
      expect([upstream.code, upstream.stderr]).toEqual([1, ` ERROR  ${NAME} is not installed\n`]);
    });
  });

  test("an unknown name exits 1 with the closest installed name; --source narrows the refusal", async () => {
    await withScenario(bothRepos, async (scenario) => {
      await add(scenario, "@a/b", "-g");
      const typo = await runCli(scenario, ["show", "skip-unfit-skill"]);
      expect([typo.code, typo.stdout, typo.stderr]).toEqual([
        1,
        "",
        ` ERROR  skip-unfit-skill is not installed\nTip: did you mean ${NAME}?\n`,
      ]);
      const far = await runCli(scenario, ["show", "nothing-like-it"]);
      expect(far.stderr).toBe(" ERROR  nothing-like-it is not installed\n");
      // A spelling only a source could have is refused as a source, in the memory's document.
      const noSource = await runCli(scenario, ["show", "@nobody/nothing", "--json"]);
      expect([noSource.code, noSource.stderr, JSON.parse(noSource.stdout)]).toEqual([
        1,
        "",
        {
          ok: false,
          code: 1,
          message: "@nobody/nothing is not installed",
          hint: null,
          notices: [],
        },
      ]);
      const scoped = await runCli(scenario, ["show", NAME, "--source", "@a/c"]);
      expect(scoped.stderr).toBe(" ERROR  @a/c is not installed\n");
      const missing = await runCli(scenario, ["show", "no-such-rule", "--source", "@a/b"]);
      expect(missing.stderr).toBe(" ERROR  @a/b does not provide no-such-rule\n");
      const json = await runCli(scenario, ["show", "skip-unfit-skill", "--json"]);
      expect([json.code, json.stderr, JSON.parse(json.stdout)]).toEqual([
        1,
        "",
        {
          ok: false,
          code: 1,
          message: "skip-unfit-skill is not installed",
          hint: `did you mean ${NAME}?`,
          notices: [],
        },
      ]);
    });
  });

  // `add` refuses the second owner of a name, so two sources providing one local name is a state
  // written by hand or left by an upstream that later took a name another source owns; `show`
  // must still not pick one silently.
  test("a name two sources provide lists them and takes --source, -g or -p to pick one", async () => {
    await withScenario({ project: true }, async (scenario) => {
      const facts = await fetchedFacts(SKILLS, daysAgo(NOW, 1));
      const [user, project] = [githubFrom("a/b"), githubFrom("a/c")];
      seedStore(scenario.home, user, SKILLS);
      seedStore(scenario.home, project, SKILLS);
      writeState(
        scenario,
        stateWith({
          "@a/b": fetchedEntry(user, facts, { harnesses: ["codex"] }),
          "@a/c": fetchedEntry(project, facts, {
            harnesses: ["codex"],
            destination: { scope: "project", root: scenario.cwd },
          }),
        }),
      );
      const bare = await runCli(scenario, ["show", NAME]);
      expect([bare.code, bare.stderr]).toEqual([
        1,
        ` ERROR  ${NAME} is provided by 2 sources: @a/b, @a/c\nTip: maxims show ${NAME} --source <key>\n`,
      ]);
      expect((await shown(scenario, NAME, "--source", "@a/c")).source).toBe("@a/c");
      expect((await shown(scenario, NAME, "--source", "a/b")).source).toBe("@a/b");
      expect((await shown(scenario, NAME, "-g")).source).toBe("@a/b");
      expect((await shown(scenario, NAME, "-p")).source).toBe("@a/c");
      const disjoint = await runCli(scenario, ["show", NAME, "-g", "--source", "@a/c"]);
      expect(disjoint.stderr).toBe(` ERROR  @a/c does not provide ${NAME}\n`);
    });
  });

  test("a disabled memory says so at its scope and keeps its body", async () => {
    await withScenario(bothRepos, async (scenario) => {
      await add(scenario, "@a/b", "-g", "--rule");
      expect((await runCli(scenario, ["disable", NAME, "-g"])).code).toBe(0);
      const document = await shown(scenario, NAME);
      expect(document).toMatchObject({ disabled: true, held: false, body: FILE });
      expect(document.ruleLine).not.toBeNull();
      const run = await runCli(scenario, ["show", NAME]);
      expect(run.stdout).toContain("   disabled: yes\n");
    });
  });

  test("a held revision is reported with the show hint while the installed body still prints", async () => {
    await withScenario({}, async (scenario) => {
      const from = githubFrom("acme/rules");
      seedStore(scenario.home, from, SKILLS);
      const facts = await fetchedFacts(SKILLS, daysAgo(NOW, 1));
      const pending = {
        sha: gitSha("b".repeat(40)),
        at: NOW.toISOString(),
        summary: [`~ ${NAME} (aaaaaaa -> bbbbbbb)`],
      };
      writeState(
        scenario,
        stateWith({
          "@acme/rules": fetchedEntry(from, facts, { harnesses: ["codex"], review: true }, pending),
        }),
      );
      const document = await shown(scenario, NAME);
      expect(document).toMatchObject({ held: true, sha: facts.sha, body: FILE });
      const run = await runCli(scenario, ["show", NAME]);
      expect(run.stdout).toContain("   held: yes (run maxims show @acme/rules)\n");
    });
  });

  test("a source whose store copy is gone is a warning, never a match or a suggestion", async () => {
    await withScenario(bothRepos, async (scenario) => {
      await add(scenario, "@a/b", "-g");
      const from = githubFrom("acme/rules");
      const facts = await fetchedFacts(SKILLS, daysAgo(NOW, 1));
      const state = JSON.parse(readFileSync(homePaths(scenario.home).state, "utf8"));
      state.sources["@acme/rules"] = fetchedEntry(from, facts, { harnesses: ["codex"] });
      writeState(scenario, state);
      const run = await runCli(scenario, ["show", NAME]);
      expect([run.code, run.stderr]).toEqual([0, ""]);
      expect(run.stdout.startsWith("!  maxims: @acme/rules: not fetched yet\n|\n")).toBe(true);
      const document = await shown(scenario, NAME);
      expect([document.source, document.notices]).toEqual([
        "@a/b",
        ["maxims: @acme/rules: not fetched yet"],
      ]);
      // A name nobody readable provides is refused with the unreadable source beside it, so a
      // `--json` caller can tell "not installed" from "not readable right now".
      const absent = await runCli(scenario, ["show", "no-such-rule", "--json"]);
      expect([absent.code, absent.stderr, JSON.parse(absent.stdout)]).toEqual([
        1,
        "",
        {
          ok: false,
          code: 1,
          message: "no-such-rule is not installed",
          hint: null,
          notices: ["maxims: @acme/rules: not fetched yet"],
        },
      ]);
    });
  });

  test("a corrupt state file stops the read and is left exactly where it was", async () => {
    await withScenario({}, async (scenario) => {
      const path = homePaths(scenario.home).state;
      writeFileSync(path, '{"version": 1, "sources": "nope"}\n');
      const before = await snapshot(scenario.root);
      const run = await runCli(scenario, ["show", NAME]);
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(
        /^ ERROR {2}state\.json is corrupt: .*; run maxims sync to quarantine it\n$/,
      );
      expect(readFileSync(path, "utf8")).toBe('{"version": 1, "sources": "nope"}\n');
      expect(readdirSync(scenario.home)).toEqual(["state.json"]);
      const json = await runCli(scenario, ["show", NAME, "--json"]);
      expect([json.code, json.stderr]).toEqual([1, ""]);
      expect(JSON.parse(json.stdout)).toEqual({
        ok: false,
        code: 1,
        message: expect.stringMatching(
          /^state\.json is corrupt: .*; run maxims sync to quarantine it$/,
        ),
        hint: null,
        notices: [],
      });
      expect(await snapshot(scenario.root)).toBe(before);
    });
  });
});

function splitAtBody(stdout: string): [string, string] {
  const at = stdout.indexOf("|\n---\n");
  if (at === -1) throw new Error(`no body follows the frame in:\n${stdout}`);
  return [stdout.slice(0, at + "|\n".length), stdout.slice(at + "|\n".length)];
}

function regexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
