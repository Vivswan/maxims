// Shared by every fuzz file: the knob reader scaled for cases that cost microseconds, the text
// generators that reach the byte shapes a hand-written case list never does, and the timing helper
// that turns a documented complexity into a per-input budget.
import fc from "fast-check";
import { checkProperty, propertyKnobs } from "../shared/property.ts";

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

export async function asyncOutcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { kind: "value", value: await fn() };
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

type JsonPath = (string | number)[];

function jsonPaths(value: unknown, prefix: JsonPath = []): JsonPath[] {
  const paths: JsonPath[] = [prefix];
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      paths.push(...jsonPaths(item, [...prefix, index]));
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      paths.push(...jsonPaths(item, [...prefix, key]));
    }
  }
  return paths;
}

type Mutation = { path: JsonPath } & (
  | { kind: "drop" }
  | { kind: "replace"; value: unknown }
  | { kind: "wrong-type" }
);

// The same value in another JSON type, so a schema's type check is what the mutation lands on.
function wrongType(value: unknown): unknown {
  if (typeof value === "string") return value.length;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (value === null) return 0;
  return Array.isArray(value) ? {} : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childOf(parent: unknown, step: string | number): unknown {
  if (Array.isArray(parent)) return typeof step === "number" ? parent[step] : undefined;
  return isRecord(parent) ? parent[String(step)] : undefined;
}

// The replacement is cloned on every apply: fast-check keeps the mutation list for shrinking, and
// a later mutation reaching into a shared replacement object would change what was retained.
function applyMutation(root: unknown, mutation: Mutation): unknown {
  const { path } = mutation;
  const replacement = (current: unknown): unknown =>
    mutation.kind === "replace" ? structuredClone(mutation.value) : wrongType(current);
  if (path.length === 0) return replacement(root);
  let parent: unknown = root;
  for (const step of path.slice(0, -1)) parent = childOf(parent, step);
  const last = path[path.length - 1] ?? "";
  if (Array.isArray(parent) && typeof last === "number") {
    if (mutation.kind === "drop") parent.splice(last, 1);
    else parent[last] = replacement(parent[last]);
    return root;
  }
  if (!isRecord(parent)) return root;
  const key = String(last);
  if (mutation.kind === "drop") delete parent[key];
  else parent[key] = replacement(parent[key]);
  return root;
}

// A valid document with one to three of its nodes dropped, retyped or replaced by a random JSON
// value: the near misses a hand edit or an older writer produces, which a random document from
// scratch almost never reaches past the first schema check.
export function mutatedJson(base: unknown): fc.Arbitrary<unknown> {
  const paths = jsonPaths(base);
  const mutation: fc.Arbitrary<Mutation> = fc
    .tuple(
      fc.constantFrom(...paths),
      fc.oneof(
        fc.constant({ kind: "drop" as const }),
        fc.constant({ kind: "wrong-type" as const }),
        fc.jsonValue({ maxDepth: 2 }).map((value) => ({ kind: "replace" as const, value })),
      ),
    )
    .map(([path, op]) => ({ path, ...op }));
  return fc
    .array(mutation, { minLength: 1, maxLength: 3 })
    .map((mutations) =>
      mutations.reduce((doc, next) => applyMutation(doc, next), structuredClone(base)),
    );
}
