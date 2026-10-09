// A figure another script wrote as one flat JSON object (`{"medianMs": 41.2}`, `{"bytes": n}`).
// A missing or non-positive value means the producer changed shape or measured nothing, and
// would otherwise flow into a delta as NaN.
import { readFileSync } from "node:fs";

export function readPositiveNumber(path: string, key: string): number {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed === "object" && parsed !== null && key in parsed) {
    const value: unknown = Reflect.get(parsed, key);
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  throw new Error(`${path} has no positive number at ${key}`);
}

export type Unit = "ms" | "bytes";

export const percent = (ratio: number): string =>
  `${ratio * 100 >= 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%`;

export function quantity(value: number, unit: Unit): string {
  return unit === "ms" ? `${value.toFixed(1)} ms` : `${value.toLocaleString("en-US")} bytes`;
}
