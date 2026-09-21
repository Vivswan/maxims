import { z } from "zod";

export const HARNESS_IDS = [
  "claude-code",
  "codex",
  "gemini-cli",
  "copilot",
  "cursor",
  "cline",
  "opencode",
  "dsh",
  "devin",
  "windsurf",
  "zed",
  "amp",
  "warp",
  "pi",
] as const;

export type BuiltInHarnessId = (typeof HARNESS_IDS)[number];

export const HARNESS_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function isBuiltInHarnessId(value: string): value is BuiltInHarnessId {
  return HARNESS_IDS.some((id) => id === value);
}

declare const userHarnessIdBrand: unique symbol;

// An id outside the built-in list: one declared in `$MAXIMS_HOME/harnesses.json`. State keeps
// such an id as intent even after the file stops defining it; sync notices and skips it rather
// than dropping it. `parseUserHarnessId` is the one place the brand is minted.
export type UserHarnessId = string & { readonly [userHarnessIdBrand]: true };

export type HarnessId = BuiltInHarnessId | UserHarnessId;

export function parseUserHarnessId(value: string): UserHarnessId | null {
  if (!HARNESS_ID_PATTERN.test(value) || isBuiltInHarnessId(value)) return null;
  return value as UserHarnessId;
}

// A user-defined id stays valid state after harnesses.json stops defining it: intent is never
// dropped on a read, and sync is what notices the gap and skips that harness.
export const HarnessIdSchema = z.custom<HarnessId>(
  (value) =>
    typeof value === "string" && (isBuiltInHarnessId(value) || parseUserHarnessId(value) !== null),
  { error: "expected a built-in harness id or a kebab-case user-defined one" },
);
