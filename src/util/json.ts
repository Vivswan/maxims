// The one spelling of an indented JSON document, so a file maxims writes and a `--json` document
// end alike: two spaces, trailing newline. Single values and hook stdout stay compact.
export function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
