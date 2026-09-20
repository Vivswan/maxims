// The two knobs every property run reads: MAXIMS_PROPERTY_ITERATIONS is the run count (each suite
// names its own default; a deep run sets hundreds), MAXIMS_PROPERTY_SEED replays one failing run.
// A failure names the seed to set, so a red run elsewhere is reproduced here with one variable.
import fc from "fast-check";

export type PropertyKnobs = { numRuns: number; seed: number | undefined };

// Sized for the engine convergence suite, whose every run drives the whole engine. A suite whose
// runs are cheaper scales it (the fuzz multiplier) or passes its own default (the marker corpus).
const DEFAULT_ITERATIONS = 8;

// A property runs the engine hundreds of times on a deep run, so its test outlives the runner's
// default five seconds by a wide margin.
export const PROPERTY_TIMEOUT_MS = 15 * 60 * 1000;

// A knob that is set but unreadable stops the run: a typo that fell back to the default would
// run the default count while the caller believes it ran two hundred, or a fresh seed while the
// caller believes it replayed a failure. An empty value is the shell's way of leaving a knob
// unset; a seed is the signed 32-bit integer a failure report prints.
export function propertyKnobs(
  env: NodeJS.ProcessEnv = process.env,
  defaultRuns: number = DEFAULT_ITERATIONS,
): PropertyKnobs {
  const numRuns = knob(env, "MAXIMS_PROPERTY_ITERATIONS", /^[1-9]\d*$/, [
    1,
    Number.MAX_SAFE_INTEGER,
  ]);
  const seed = knob(env, "MAXIMS_PROPERTY_SEED", /^-?\d+$/, [-(2 ** 31), 2 ** 31 - 1]);
  return { numRuns: numRuns ?? defaultRuns, seed };
}

function knob(
  env: NodeJS.ProcessEnv,
  name: string,
  shape: RegExp,
  [min, max]: [number, number],
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!shape.test(raw) || value < min || value > max) {
    throw new Error(`${name}=${JSON.stringify(raw)} is not an integer in [${min}, ${max}]`);
  }
  return value;
}

// fc.assert over a synchronous property; bun test prints an error's message and never its cause,
// so the failing assertion's text rides inline under the counterexample.
export function propertyOptions(defaultRuns: number = DEFAULT_ITERATIONS): {
  numRuns: number;
  seed?: number;
  includeErrorInReport: true;
} {
  const knobs = propertyKnobs(process.env, defaultRuns);
  return {
    numRuns: knobs.numRuns,
    ...(knobs.seed === undefined ? {} : { seed: knobs.seed }),
    includeErrorInReport: true,
  };
}

// Runs the property under the knobs and turns a failure into one assertion error carrying the
// replay line, the shrunk counterexample and the underlying failure. A caller that scales the run
// count past the knob names the knob's own value as `replayIterations`, so the printed line
// reproduces the run instead of scaling it again.
export async function checkProperty<T>(
  name: string,
  property: fc.IAsyncProperty<T>,
  knobs: PropertyKnobs = propertyKnobs(),
  replayIterations: number = knobs.numRuns,
): Promise<void> {
  const details = await fc.check(property, {
    numRuns: knobs.numRuns,
    ...(knobs.seed === undefined ? {} : { seed: knobs.seed }),
  });
  if (!details.failed) return;
  const cause = details.errorInstance;
  const detail = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
  throw new Error(
    `${name} failed; replay with MAXIMS_PROPERTY_SEED=${details.seed} MAXIMS_PROPERTY_ITERATIONS=${replayIterations}\n${fc.defaultReportMessage(details)}\n${detail}`,
  );
}
