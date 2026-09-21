// Guards the user-config boundary: a misspelled key in config.json must be refused rather than
// silently ignored, a missing file must mean "no defaults", not an error, and the accepted range
// of the two integer keys must not drift under a hand-edited file.
import { expect, test } from "bun:test";
import { parseUserConfig } from "./config.ts";

test("parseUserConfig: valid file, absent file, and a strict rejection of unknown keys", () => {
  expect(
    parseUserConfig({ agents: ["claude-code", "codex"], yes: true, rule: true, cooldownDays: 3 }),
  ).toEqual({
    ok: true,
    config: { agents: ["claude-code", "codex"], yes: true, rule: true, cooldownDays: 3 },
  });
  expect(parseUserConfig(undefined)).toEqual({ ok: true, config: {} });
  const corrupt = parseUserConfig({ agents: ["claude-code"], cooldown: 3 });
  expect(corrupt.ok).toBe(false);
  if (corrupt.ok) return;
  expect(corrupt.issues.some((line) => /cooldown/.test(line))).toBe(true);
  // config.json is hand-edited, so the file's accepted range is a contract: a zero cooldown is a
  // valid "refetch every sync", a negative one and a zero cap are not.
  const bounds: [Record<string, number>, boolean][] = [
    [{ cooldownDays: 0 }, true],
    [{ cooldownDays: -1 }, false],
    [{ ruleCap: 0 }, false],
  ];
  expect(bounds.map(([json]) => parseUserConfig(json).ok)).toEqual(bounds.map(([, ok]) => ok));
  // A user-declared harness id is a valid default, not only the built-in ones.
  expect(parseUserConfig({ agents: ["team-agent"] }).ok).toBe(true);
});
