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
