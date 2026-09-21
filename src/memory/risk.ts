// A memory's one-line description installs into every agent's always-loaded instructions, where a
// sentence that reads as prose can carry a fetch-and-run pipe, an override phrase, a homoglyph, or
// a leaked secret. This REPORTS such shapes for a caller to surface; it decides no policy, mirroring
// hiddenCharacters in contract.ts which judges code points while this judges what the sentence says.

export const RISK_KINDS = [
  "shell-pipe",
  "url",
  "override",
  "mixed-script",
  "encoded-blob",
  "sensitive-path",
  "secret-shape",
] as const;

export type RiskKind = (typeof RISK_KINDS)[number];

export type RiskWarning = { kind: RiskKind; detail: string; column: number };

type Hit = { column: number; detail: string };
type Detector = (line: string) => Hit | null;

const FETCH = /\b(?:curl|wget|iwr|invoke-webrequest)\b/i;
// The interpreter may sit behind "sudo" and "/usr/bin/env"; "iex" is PowerShell's alias for
// Invoke-Expression, the canonical Windows one-liner. The sudo flags and the python version are
// bounded because every backtrack into them re-runs the trailing lookahead over the rest of the
// line: "python1.1.1...", unbounded, went quadratic.
//
// sudo's short flags that take an argument always consume the next token, so "sudo -u bash tee"
// names a user, not a shell; a flag free to drop its argument would fire on it. The other flags
// never take one, so "sudo -E bash now" still fires, also when clustered ahead of an argument flag
// ("sudo -Eu root bash"). Under the i flag -a, -h and -p would swallow the bare -A, -H and -P, so
// those three read as bare: "sudo -H bash" fires, "sudo -h host bash" does not.
const SUDO_ARG_FLAGS = "cdgrtu";
const SUDO_BARE_FLAGS = [..."abcdefghijklmnopqrstuvwxyz"]
  .filter((letter) => !SUDO_ARG_FLAGS.includes(letter))
  .join("");
const SUDO_ARG_CLUSTER = `-[${SUDO_BARE_FLAGS}]*[${SUDO_ARG_FLAGS}]\\s`;
const SUDO_FLAGS = `(?:\\s+${SUDO_ARG_CLUSTER}+[^\\s-]\\S*|\\s+(?!${SUDO_ARG_CLUSTER})-\\S+){0,3}`;
const PIPE_INTO = new RegExp(
  `(?<!\\|)\\|(?!\\|)\\s*["']?(?:sudo${SUDO_FLAGS}\\s+)?(?:(?:[\\w./-]*\\/)?env\\s+)?(?:[\\w./-]*\\/)?(sh|bash|zsh|powershell|pwsh|python\\d?(?:\\.\\d+)?|node|iex|invoke-expression)\\b(?![\\w.-]*\\/)`,
  "i",
);
const PWSH = /\b(?:powershell|pwsh)\b/i;
const ENC_FLAG = /-(?:enc|encodedcommand)\b/i;
const SHELL_DASH_C = /\b(?:sh|bash|zsh|pwsh|powershell)\b\s+-c\b/i;
const SUBSHELL_FETCH = /\$\(\s*(?:curl|wget|iwr|invoke-webrequest)\b/i;

// Each sub-shape scans from its own anchor once, never retrying a later anchor, so a line of many
// "curl" tokens cannot drive the seek-to-pipe scan quadratic. The earliest sub-shape wins.
function shellPipe(line: string): Hit | null {
  const hits: Hit[] = [];
  const fetch = FETCH.exec(line);
  if (fetch) {
    const pipe = PIPE_INTO.exec(line.slice(fetch.index));
    if (pipe) {
      hits.push({
        column: fetch.index,
        detail: `${fetch[0].toLowerCase()} piped into ${pipe[1].toLowerCase()}`,
      });
    }
  }
  const pwsh = PWSH.exec(line);
  if (pwsh && ENC_FLAG.exec(line.slice(pwsh.index))) {
    hits.push({ column: pwsh.index, detail: `${pwsh[0].toLowerCase()} with an encoded command` });
  }
  const dashC = SHELL_DASH_C.exec(line);
  if (dashC && SUBSHELL_FETCH.exec(line.slice(dashC.index))) {
    hits.push({ column: dashC.index, detail: "inline command substitution fetching a script" });
  }
  return leftmost(hits);
}

// Finding a URL is a regex job, but naming its host is not: any hand-rolled authority parsing
// disagrees with the real parser somewhere, and a "trusted@evil.example" a browser resolves to
// evil.example must never read as trusted. So each "://" candidate hands its authority to the WHATWG
// URL parser rather than a regex; a bare "https://" names no host.
const SCHEME = /https?:\/\//gi;
const AUTHORITY_END = /[\s\\/?#]/;

// The character that opens a URL says where its markup closes it (the keys are openers, the values
// closers); an unquoted href value ("=") ends at the tag's ">". A code span is not an opener but a
// region: its own end bounds any URL inside it (codeSpans). Nothing else closes a URL early, so a
// quote or bracket glued inside an unopened authority ('trusted.example"@evil.example') stays the
// userinfo the parser resolves past. Code spans are read without HTML tag precedence, so a backtick
// inside a tag's attribute opens one. Three shapes are the recorded price of those rules:
//
//   [docs](https://user:p)w@example.com)                  -> no url (")" in userinfo ends the link)
//   destination=https://trusted.example>@evil.example/x   -> trusted.example (">" ends the href)
//   <a title="`" href="https://trusted.example`@evil.example">  -> trusted.example (span in a tag)
const CLOSERS: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  "=": ">",
  "<": ">",
  "(": ")",
};

function url(line: string): Hit | null {
  const spans = codeSpans(line);
  let cursor = 0;
  for (const match of line.matchAll(SCHEME)) {
    let span = spans[cursor];
    while (span !== undefined && span.end <= match.index) span = spans[++cursor];
    const limit = span !== undefined && span.start <= match.index ? span.end : line.length;
    const closer = CLOSERS[openerBefore(line, match.index)] ?? null;
    let start = match.index + match[0].length;
    while (line[start] === "/" || line[start] === "\\") start++;
    let end = start;
    while (end < limit && !endsAuthority(line[end] ?? "", closer)) end++;
    const host = hostOf(`${match[0]}${line.slice(start, end)}`);
    if (host !== null) return { column: match.index, detail: host };
  }
  return null;
}

function endsAuthority(char: string, closer: string | null): boolean {
  return AUTHORITY_END.test(char) || char === closer;
}

// CommonMark allows blanks between a link destination's "(" and the URL, so "(" is looked for past
// them; no other opener is, since a blank after a quote or "=" is prose, not an attribute value.
function openerBefore(line: string, at: number): string {
  let index = at - 1;
  while (line[index] === " " || line[index] === "\t") index--;
  const char = line[index] ?? "";
  return index === at - 1 || char === "(" ? char : "";
}

// CommonMark code spans: a run of N backticks opens a span that the NEXT run of exactly N closes;
// runs of any other length in between are literal, and a run with no partner is literal, so the
// lone backticks in ``prefix `https://trusted.example`@evil.example`` are text and the span's end
// is what bounds the URL. A backslash escapes the first backtick of a run only in text, never
// inside a span. The partner search is a binary search over that length's run positions, so a
// line of many unpaired runs stays near linear.
type Span = { start: number; end: number };
type Run = { at: number; length: number };
const BACKTICK = "`".charCodeAt(0);
const BACKSLASH = "\\".charCodeAt(0);

function codeSpans(line: string): Span[] {
  const runs = backtickRuns(line);
  const runsOfLength = new Map<number, number[]>();
  runs.forEach((run, index) => {
    const same = runsOfLength.get(run.length);
    if (same === undefined) runsOfLength.set(run.length, [index]);
    else same.push(index);
  });
  const spans: Span[] = [];
  for (let index = 0; index < runs.length; index++) {
    const open = runs[index];
    if (open === undefined) break;
    const escapes = escapedAt(line, open.at) ? 1 : 0;
    const closeIndex = firstAfter(runsOfLength.get(open.length - escapes) ?? [], index);
    const close = closeIndex === undefined ? undefined : runs[closeIndex];
    if (closeIndex === undefined || close === undefined) continue;
    spans.push({ start: open.at + open.length, end: close.at });
    index = closeIndex;
  }
  return spans;
}

function backtickRuns(line: string): Run[] {
  const runs: Run[] = [];
  for (let at = line.indexOf("`"); at !== -1; at = line.indexOf("`", at)) {
    let end = at + 1;
    while (line.charCodeAt(end) === BACKTICK) end++;
    runs.push({ at, length: end - at });
    at = end;
  }
  return runs;
}

function escapedAt(line: string, at: number): boolean {
  let slashes = 0;
  while (line.charCodeAt(at - 1 - slashes) === BACKSLASH) slashes++;
  return slashes % 2 === 1;
}

function firstAfter(sorted: readonly number[], index: number): number | undefined {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sorted[mid] ?? -1) <= index) low = mid + 1;
    else high = mid;
  }
  return sorted[low];
}

// Prose wraps a URL in punctuation, markdown emphasis included, and may follow the wrapper with a
// colon ("[guide](https://example.com:443): more"); all of it trails and is stripped. A bare
// trailing colon stays: it is a dangling port the parser tolerates, and inside an IPv6 literal
// whose "]" was just stripped, "::" is address syntax.
const TRAILING_WRAPPERS = ").,;!?}]'\"`>*_";
const WRAPPER_CHAR = /["'<>`|]/;

function hostOf(token: string): string | null {
  const direct = parseAuthority(token);
  if (direct !== null) return direct;
  // A URL glued to a shell pipe ("get.x.example|sh") or to stray markup parses only once cut at
  // the first character no URL can carry unencoded in a host. The whole authority is tried first,
  // so a "|" that is valid userinfo has already resolved before the cut runs.
  const cut = token.search(WRAPPER_CHAR);
  return cut > 0 ? parseAuthority(token.slice(0, cut)) : null;
}

// Stripping may take an IPv6 literal's "]", so one is restored once the stripped form fails,
// leaving a "[" inside userinfo for the parser. A prose colon after an explicit port
// ("https://example.com:8080: the docs") is the one colon the parser rejects, so a failed parse
// retries once without it: once, never per colon, so a colon flood stays linear.
function parseAuthority(candidate: string): string | null {
  const trimmed = trimTrailing(candidate);
  const host = tryBracketed(trimmed);
  if (host !== null || !trimmed.endsWith(":")) return host;
  return tryBracketed(trimmed.slice(0, -1));
}

function tryBracketed(text: string): string | null {
  const host = tryHost(text);
  if (host !== null) return host;
  return hasOpenBracket(text) ? tryHost(`${text}]`) : null;
}

function hasOpenBracket(text: string): boolean {
  return text.lastIndexOf("[") > text.lastIndexOf("]");
}

// URL.canParse asks the real parser without the cost of a thrown exception, so a line of a million
// unparsable "://" candidates stays linear.
function tryHost(candidate: string): string | null {
  if (!URL.canParse(candidate)) return null;
  const host = new URL(candidate).hostname;
  return host === "" ? null : host;
}

function trimTrailing(text: string): string {
  let end = text.length;
  while (end > 0) {
    const last = text[end - 1] ?? "";
    if (isWrapper(last) || (last === ":" && isWrapper(text[end - 2] ?? ""))) end--;
    else break;
  }
  return text.slice(0, end);
}

function isWrapper(char: string): boolean {
  return char !== "" && TRAILING_WRAPPERS.includes(char);
}

const HAS_LATIN = /\p{Script=Latin}/u;
const FOREIGN_SCRIPTS: readonly (readonly [string, RegExp])[] = [
  ["Cyrillic", /\p{Script=Cyrillic}/u],
  ["Greek", /\p{Script=Greek}/u],
  ["Armenian", /\p{Script=Armenian}/u],
];
// Combining marks join their base letter into one token, so a homoglyph hidden behind an accent
// cannot split into two single-script words that each read as clean.
const WORD = /[\p{L}\p{M}]+/gu;

function mixedScript(line: string): Hit | null {
  for (const match of line.matchAll(WORD)) {
    const word = match[0];
    if (!HAS_LATIN.test(word)) continue;
    for (const [name, script] of FOREIGN_SCRIPTS) {
      if (script.test(word)) {
        return { column: match.index, detail: `Latin+${name} in "${word}"` };
      }
    }
  }
  return null;
}

const BASE64_RUN = /[A-Za-z0-9+/=]{40,}/g;
const HEX_RUN = /[0-9a-fA-F]{32,}/;
const HAS_DIGIT = /[0-9]/;
const HAS_LOWER = /[a-z]/;
const HAS_UPPER = /[A-Z]/;

function encodedBlob(line: string): Hit | null {
  const hits: Hit[] = [];
  for (const match of line.matchAll(BASE64_RUN)) {
    const run = match[0];
    if (HAS_DIGIT.test(run) && HAS_LOWER.test(run) && HAS_UPPER.test(run)) {
      hits.push({ column: match.index, detail: `base64-like run of ${run.length} characters` });
      break;
    }
  }
  const hex = HEX_RUN.exec(line);
  if (hex) hits.push({ column: hex.index, detail: `hex run of ${hex[0].length} characters` });
  return leftmost(hits);
}

type Entry = { re: RegExp; detail: (match: RegExpExecArray) => string };

function scan(line: string, entries: readonly Entry[]): Hit | null {
  let best: Hit | null = null;
  for (const { re, detail } of entries) {
    const match = re.exec(line);
    if (match && (best === null || match.index < best.column)) {
      best = { column: match.index, detail: detail(match) };
    }
  }
  return best;
}

const OVERRIDE_ENTRIES: readonly Entry[] = [
  /\bignore\s+(?:all|any|the|your)\s+(?:previous|prior|earlier|above)\s+(?:instructions|rules)\b/i,
  /\bdisregard\s+(?:your|the|all)\s+(?:rules|instructions)\b/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+instructions:/i,
  /\bsystem\s+prompt\b/i,
  /\bdo\s+not\s+tell\s+the\s+user\b/i,
  /\bwithout\s+telling\b/i,
].map((re) => ({ re, detail: (match) => match[0].toLowerCase().replace(/\s+/g, " ") }));

const SENSITIVE_ENTRIES: readonly Entry[] = [
  /~\/\.ssh(?![\w])/i,
  /~\/\.aws(?![\w])/i,
  /~\/\.gnupg(?![\w])/i,
  /\/etc\/passwd(?![\w])/i,
  /\/etc\/shadow(?![\w])/i,
  /(?<![\w])\.env(?![\w])/i,
  /\bid_rsa\b/i,
  /\bcredentials\b/i,
  /(?<![\w])\.npmrc(?![\w])/i,
  /(?<![\w])\.netrc(?![\w])/i,
  /\bkeychain\b/i,
].map((re) => ({ re, detail: (match) => match[0].toLowerCase() }));

const SECRET_ENTRIES: readonly Entry[] = (
  [
    ["GitHub token (ghp_)", /ghp_[A-Za-z0-9]{36}/],
    ["GitHub fine-grained token (github_pat_)", /github_pat_/],
    ["OpenAI-style key (sk-)", /sk-[A-Za-z0-9]{20,}/],
    ["AWS access key id (AKIA)", /AKIA[0-9A-Z]{16}/],
    ["Slack token (xox)", /xox[abp]-/],
    ["PEM private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["Google API key (AIza)", /AIza[0-9A-Za-z_-]{35}/],
  ] as const
).map(([label, re]) => ({ re, detail: () => label }));

const DETECTORS: Record<RiskKind, Detector> = {
  "shell-pipe": shellPipe,
  url,
  override: (line) => scan(line, OVERRIDE_ENTRIES),
  "mixed-script": mixedScript,
  "encoded-blob": encodedBlob,
  "sensitive-path": (line) => scan(line, SENSITIVE_ENTRIES),
  "secret-shape": (line) => scan(line, SECRET_ENTRIES),
};

// A column is an offset into the whole description, not into its line, so a caller can point at the
// exact character. Only the first hit of each kind is kept.
export function riskWarnings(description: string): RiskWarning[] {
  const found = new Map<RiskKind, RiskWarning>();
  let offset = 0;
  for (const line of description.split("\n")) {
    for (const kind of RISK_KINDS) {
      if (found.has(kind)) continue;
      const hit = DETECTORS[kind](line);
      if (hit) found.set(kind, { kind, detail: hit.detail, column: offset + hit.column });
    }
    offset += line.length + 1;
  }
  return [...found.values()].sort((a, b) => a.column - b.column);
}

function leftmost(hits: Hit[]): Hit | null {
  let best: Hit | null = null;
  for (const hit of hits) if (best === null || hit.column < best.column) best = hit;
  return best;
}
