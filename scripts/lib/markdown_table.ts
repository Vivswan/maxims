// One GFM table: a header row, the rule, one row per entry, with a pipe inside a cell escaped so
// it cannot split the row. The nightly reports and the generated docs tables share it.
export function markdownTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;
  return [line(header), `|${header.map(() => "---").join("|")}|`, ...rows.map(line)].join("\n");
}
