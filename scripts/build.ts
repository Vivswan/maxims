import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { whereBytesLand } from "./lib/paths.ts";

const SHEBANG = "#!/usr/bin/env node\n";
const DEFAULT_ENTRY = "src/cli.ts";
const DEFAULT_OUTFILE = "dist/cli.js";
const repoRoot = resolve(import.meta.dir, "..");

interface Options {
  entry: string | undefined;
  outfile: string | undefined;
  sizeJson: string | undefined;
}

const FLAGS = new Map<string, keyof Options>([
  ["--entry", "entry"],
  ["--outfile", "outfile"],
  ["--size-json", "sizeJson"],
]);

function fail(message: string): never {
  process.stderr.write(`build: ${message}\n`);
  process.stderr.write(
    "usage: bun scripts/build.ts [--entry path] [--outfile path] [--size-json path]\n",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = { entry: undefined, outfile: undefined, sizeJson: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const key = FLAGS.get(flag);
    if (key === undefined) fail(`unknown argument ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`${flag} needs a value`);
    options[key] = value;
    i++;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
// Caller-supplied paths are relative to the caller's cwd; resolve them before the chdir below.
// The two outputs are compared by where their bytes land, so a second spelling of the bundle
// path (a `..` segment, a symlinked directory) cannot make the size report overwrite it.
const entry = options.entry === undefined ? join(repoRoot, DEFAULT_ENTRY) : resolve(options.entry);
const outfile = whereBytesLand(options.outfile ?? join(repoRoot, DEFAULT_OUTFILE), fail);
const sizeJson =
  options.sizeJson === undefined ? undefined : whereBytesLand(options.sizeJson, fail);
if (sizeJson === outfile) {
  fail(`--outfile and --size-json both land at ${outfile}; the report would overwrite the bundle`);
}

// Bun writes module-boundary comments relative to the cwd; anchoring at the repo root keeps the
// artifact byte-identical no matter where the build is invoked from.
process.chdir(repoRoot);

// jsonc-parser's `main` is a UMD bundle that `require`s its ./impl siblings when the factory runs;
// once bundled, node resolves those against a file that no longer exists and the artifact dies on
// load. Its `module` entry imports them statically, so that is the copy the bundle takes.
function esmEntryOf(packageName: string): string {
  const manifestPath = fileURLToPath(import.meta.resolve(`${packageName}/package.json`));
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  const esmEntry =
    typeof manifest === "object" && manifest !== null && "module" in manifest
      ? manifest.module
      : undefined;
  if (typeof esmEntry !== "string") {
    throw new Error(`${manifestPath} has no "module" field to bundle in place of "main"`);
  }
  return join(dirname(manifestPath), esmEntry);
}
const jsoncParserEsm = esmEntryOf("jsonc-parser");

// Without `throw: false` a failed bundle surfaces as an uncaught AggregateError whose dump hides
// the bundler's own messages; asking for the result instead lets them print with their code frames.
const result = await Bun.build({
  entrypoints: [entry],
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "none",
  throw: false,
  plugins: [
    {
      name: "jsonc-parser-esm-entry",
      setup(build) {
        build.onResolve({ filter: /^jsonc-parser$/ }, () => ({ path: jsoncParserEsm }));
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) process.stderr.write(`${Bun.inspect(log)}\n`);
  process.stderr.write("build: bundling failed\n");
  process.exit(1);
}
const [artifact, ...extra] = result.outputs;
if (artifact === undefined || extra.length > 0) {
  process.stderr.write(`build: expected one output file, got ${result.outputs.length}\n`);
  process.exit(1);
}

const bundled = await artifact.text();
// Bun currently preserves the entry's shebang; stripping any leading one before prepending ours
// makes the artifact independent of that behavior.
const body = bundled.startsWith("#!") ? bundled.slice(bundled.indexOf("\n") + 1) : bundled;
const output = Buffer.from(SHEBANG + body);

mkdirSync(dirname(outfile), { recursive: true });
writeFileSync(outfile, output);
chmodSync(outfile, 0o755);

if (sizeJson !== undefined) {
  mkdirSync(dirname(sizeJson), { recursive: true });
  writeFileSync(sizeJson, `${JSON.stringify({ bytes: output.byteLength })}\n`);
}
process.stdout.write(`bundle: ${options.outfile ?? DEFAULT_OUTFILE} ${output.byteLength} bytes\n`);
