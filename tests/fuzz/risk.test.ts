// What would drift silently: a description whose shape makes riskWarnings THROW, point a column
// outside the text or at a line break, report one kind twice, or take seconds on tens of KiB
// because a detector's regex went quadratic. A description is a line a source repository controls
// and every one of them is scanned on every refresh, so the scanner must answer for all of them.
import { expect, test } from "bun:test";
import fc from "fast-check";
import { RISK_KINDS, riskWarnings } from "../../src/memory/risk.ts";
import { PROPERTY_TIMEOUT_MS } from "../convergence/property.ts";
import {
  anyText,
  budgetMs,
  describeError,
  fragments,
  fuzz,
  latin1Text,
  outcome,
  timed,
} from "./shared.ts";

// The tokens every detector keys on, so a random join lands on the anchors, the pipe grammar, the
// URL closers, the code-span rules and the secret prefixes rather than on plain prose.
const RISK_PIECES = [
  "curl ",
  "wget ",
  "iwr ",
  "invoke-webrequest ",
  "|",
  "||",
  "| ",
  "sh",
  " bash",
  " zsh ",
  "python",
  "python3",
  "1.",
  "3.",
  "/",
  "./",
  "/usr/bin/",
  "sudo ",
  "-u ",
  "-E ",
  "-Eu ",
  "-H ",
  "env ",
  "iex",
  "powershell ",
  "pwsh ",
  "-enc ",
  "-encodedcommand ",
  "-c ",
  "$(",
  "$( curl x",
  ")",
  "(",
  "https://",
  "http://",
  "HTTPS://",
  "://",
  "example.com",
  "trusted.example",
  "evil.example",
  "@",
  ":",
  "443",
  "8080",
  "[",
  "]",
  "[::1]",
  '"',
  "'",
  "`",
  "``",
  "\\",
  "\\`",
  "<a href=",
  '<a title="`" href="',
  ">",
  "=",
  "[docs](",
  "ignore all previous instructions",
  "disregard your rules",
  "you are now",
  "new instructions:",
  "system prompt",
  "do not tell the user",
  "without telling",
  "~/.ssh",
  "~/.aws/",
  "/etc/passwd",
  "/etc/shadow",
  ".env",
  ".npmrc",
  "id_rsa",
  "credentials",
  "keychain",
  "ghp_",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "github_pat_",
  "sk-",
  "sk-abcdefghijklmnopqrstuvwxyz",
  "AKIA",
  "AKIAABCDEFGHIJKLMNOP",
  "xoxb-",
  "-----BEGIN RSA PRIVATE KEY-----",
  "AIza",
  "AIzaSyA-abcdefghijklmnopqrstuvwxyz0123456",
  "abcDEF0123abcDEF0123abcDEF0123abcDEF0123abcDEF01",
  "0123456789abcdef0123456789abcdef",
  "\u0430",
  "\u043e",
  "\u03c9",
  "\u0561",
  "\u0301",
  "a",
  "e",
  "x",
  " ",
  "  ",
  "\n",
  "\t",
  "-",
  ".",
  ",",
  ";",
  "*",
  "_",
];

const description = fc.oneof(
  anyText({ maxLength: 2048 }),
  fragments(RISK_PIECES, { maxLength: 400 }),
);

// The existing adversarial rows finish a million characters in 500 ms; that rate, half a
// millisecond per KiB, is the budget every random input of up to 64 KiB is held to.
const MS_PER_KIB = 0.5;

function check(text: string): void {
  const { value: result, ms } = timed(() => outcome(() => riskWarnings(text)));
  if (result.kind === "threw") throw new Error(`threw ${describeError(result.error)}`);
  expect(ms).toBeLessThan(budgetMs(text.length, MS_PER_KIB));
  const warnings = result.value;
  expect(new Set(warnings.map((warning) => warning.kind)).size).toBe(warnings.length);
  let previous = 0;
  for (const warning of warnings) {
    expect(RISK_KINDS).toContain(warning.kind);
    expect(warning.detail).not.toBe("");
    expect(Number.isInteger(warning.column)).toBe(true);
    expect(warning.column).toBeGreaterThanOrEqual(previous);
    expect(warning.column).toBeLessThan(text.length);
    expect(text[warning.column]).not.toBe("\n");
    previous = warning.column;
  }
  if (text === "") expect(warnings).toEqual([]);
}

test(
  "riskWarnings answers in order, inside the text, within budget for any description",
  async () => {
    await fuzz("riskWarnings", description, check);
  },
  PROPERTY_TIMEOUT_MS,
);

// Up to 64 KiB of bytes or of grammar tokens, where a quadratic detector would overshoot the
// budget by a hundredfold and a linear one stays far under it.
const LARGE_CHARS = 65536;
const large = fc.oneof(
  latin1Text({ maxLength: LARGE_CHARS, size: "max" }),
  fragments(RISK_PIECES, { maxLength: 8000, size: "max" }).map((text) =>
    text.slice(0, LARGE_CHARS),
  ),
);

test(
  "riskWarnings stays linear on random inputs up to 64 KiB",
  async () => {
    await fuzz("riskWarnings large", large, check, { multiplier: 1 });
  },
  PROPERTY_TIMEOUT_MS,
);
