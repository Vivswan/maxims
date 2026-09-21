// Shared by every fuzz file: the knob reader scaled for cases that cost microseconds, the text
// generators that reach the byte shapes a hand-written case list never does, and the timing helper
// that turns a documented complexity into a per-input budget.
import fc from "fast-check";
import { checkProperty, propertyKnobs } from "../convergence/property.ts";

// A convergence property drives the whole engine per run; a fuzz case is one parser call, so the
// same knob buys this many more cases per property.
export const FUZZ_MULTIPLIER = 25;

// An input of tens of KiB costs milliseconds, not microseconds, so a property over such inputs
// runs at the knob's own count (multiplier 1) rather than the fuzz multiple.
export type FuzzOptions = { multiplier?: number };

export async function fuzz<T>(
  name: string,
  arbitrary: fc.Arbitrary<T>,
  body: (value: T) => void | Promise<void>,
  options: FuzzOptions = {},
): Promise<void> {
  const knobs = propertyKnobs();
  await checkProperty(
    name,
    fc.asyncProperty(arbitrary, async (value) => {
      await body(value);
    }),
    { ...knobs, numRuns: knobs.numRuns * (options.multiplier ?? FUZZ_MULTIPLIER) },
    knobs.numRuns,
  );
}

// Raw bytes read back through the two decodings a file reader may apply: latin1 keeps every byte
// as one code unit, utf8 turns invalid sequences into U+FFFD.
export function latin1Text(constraints: fc.IntArrayConstraints = {}): fc.Arbitrary<string> {
  return fc.uint8Array(constraints).map((bytes) => Buffer.from(bytes).toString("latin1"));
}

export function utf8Text(constraints: fc.IntArrayConstraints = {}): fc.Arbitrary<string> {
  return fc.uint8Array(constraints).map((bytes) => Buffer.from(bytes).toString("utf8"));
}

// Every string shape at once: printable ASCII, graphemes, any code point, and decoded bytes.
export function anyText(constraints: fc.StringSharedConstraints = {}): fc.Arbitrary<string> {
  return fc.oneof(
    fc.string(constraints),
    fc.string({ ...constraints, unit: "grapheme" }),
    fc.string({ ...constraints, unit: "binary" }),
    fc.string({ ...constraints, unit: "binary-ascii" }),
    latin1Text(constraints),
    utf8Text(constraints),
  );
}

// Near-miss inputs: fragments of a grammar glued in random order, so a shrunk failure reads as the
// grammar's own tokens rather than as bytes.
export function fragments(
  pieces: readonly string[],
  constraints: fc.ArrayConstraints = {},
): fc.Arbitrary<string> {
  return fc.array(fc.constantFrom(...pieces), constraints).map((parts) => parts.join(""));
}

export type Outcome<T> = { kind: "value"; value: T } | { kind: "threw"; error: unknown };

export function outcome<T>(fn: () => T): Outcome<T> {
  try {
    return { kind: "value", value: fn() };
  } catch (error) {
    return { kind: "threw", error };
  }
}

export function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

// A budget is a floor for the runner's own jitter plus a rate per KiB read off the module's
// documented complexity; a super-linear regression on the largest inputs overshoots it by orders
// of magnitude, while the floor keeps a garbage-collection pause from failing a small input.
export function budgetMs(chars: number, msPerKiB: number, floorMs = 100): number {
  return floorMs + (chars / 1024) * msPerKiB;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
