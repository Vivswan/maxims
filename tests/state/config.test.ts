// Guards the user-config boundary, where each of these would drift silently:
//
//   a misspelled key in config.json  -> refused whole, never ignored
//   an absent file                   -> no defaults, not an error
//   the two integer bounds           -> a hand edit outside them refused
//   a file with no version           -> read as version 1, current today
//   a file from a newer maxims       -> refused as newer, never parsed or rewritten
import { expect, test } from "bun:test";
import { parseUserConfig, serializeUserConfig } from "../../src/state/config.ts";
import { CURRENT_CONFIG_VERSION } from "../../src/state/migrations/config-ladder.ts";

test("parseUserConfig: valid file, absent file, and a strict rejection of unknown keys", () => {
  expect(
    parseUserConfig({ agents: ["claude-code", "codex"], yes: true, rule: true, cooldownDays: 3 }),
  ).toEqual({
    ok: "parsed",
    config: { agents: ["claude-code", "codex"], yes: true, rule: true, cooldownDays: 3 },
  });
  expect(parseUserConfig(undefined)).toEqual({ ok: "parsed", config: {} });
  const corrupt = parseUserConfig({ agents: ["claude-code"], cooldown: 3 });
  expect(corrupt.ok).toBe("corrupt");
  if (corrupt.ok !== "corrupt") return;
  expect(corrupt.issues.some((line) => /cooldown/.test(line))).toBe(true);
  // config.json is hand-edited, so the file's accepted range is a contract: a zero cooldown is a
  // valid "refetch every sync", a negative one and a zero cap are not.
  const bounds: [Record<string, number>, boolean][] = [
    [{ cooldownDays: 0 }, true],
    [{ cooldownDays: -1 }, false],
    [{ ruleCap: 0 }, false],
  ];
  expect(bounds.map(([json]) => parseUserConfig(json).ok === "parsed")).toEqual(
    bounds.map(([, ok]) => ok),
  );
  // A user-declared harness id is a valid default, not only the built-in ones.
  expect(parseUserConfig({ agents: ["team-agent"] }).ok).toBe("parsed");
});

test("the version envelope: written on every save, read back without it, and judged before the shape", () => {
  const config = { rule: true, ruleCap: 30 };
  const written = serializeUserConfig(config);
  expect(JSON.parse(written)).toEqual({ version: CURRENT_CONFIG_VERSION, ...config });
  expect(parseUserConfig(JSON.parse(written))).toEqual({ ok: "parsed", config });
  // A file with no version predates the envelope and is version 1; today that is current.
  expect(parseUserConfig(config)).toEqual({ ok: "parsed", config });
  expect(parseUserConfig({ version: CURRENT_CONFIG_VERSION + 1, anything: true })).toEqual({
    ok: "newer",
    version: CURRENT_CONFIG_VERSION + 1,
  });
  const unreachable = parseUserConfig({ version: 0, rule: true });
  expect(unreachable.ok).toBe("corrupt");
  if (unreachable.ok !== "corrupt") return;
  expect(unreachable.issues).toEqual([
    "version 0 is older than any migration this maxims carries (oldest 1)",
  ]);
  // A version that is not an integer is a shape error, not a rung; the float is one a tolerant
  // integer check once read as newer.
  for (const version of ["1", 1.5, 1.0000000000000002]) {
    expect(parseUserConfig({ version, rule: true }).ok).toBe("corrupt");
  }
});
