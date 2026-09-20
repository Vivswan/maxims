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
