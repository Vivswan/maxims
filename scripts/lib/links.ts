// A malformed percent-escape keeps the raw text: the link is then reported as the page wrote it.
export function linkFile(href: string): string {
  const bare = href.split("#")[0]?.split("?")[0] ?? "";
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}
