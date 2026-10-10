// A file maxims writes and a `--json` document share this one spelling; single values and hook
// stdout stay compact.
export function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
