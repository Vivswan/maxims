// A GitHub-flavoured markdown table; a pipe inside a cell is escaped so it cannot split the row.
export function markdownTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;
  return [line(header), `|${header.map(() => "---").join("|")}|`, ...rows.map(line)].join("\n");
}
