// The one build entry: `bun scripts/build.ts [--outfile path] [--size-json path]`.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SHEBANG = "#!/usr/bin/env node\n";
const repoRoot = resolve(import.meta.dir, "..");

interface Options {
  outfile: string;
  sizeJson: string | undefined;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { outfile: "dist/cli.js", sizeJson: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === "--outfile" || flag === "--size-json") && value !== undefined) {
      if (flag === "--outfile") options.outfile = value;
      else options.sizeJson = value;
      i++;
      continue;
    }
    process.stderr.write(`build: unknown argument ${flag}\n`);
    process.stderr.write("usage: bun scripts/build.ts [--outfile path] [--size-json path]\n");
    process.exit(2);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

// Bun writes module-boundary comments relative to the cwd; anchoring at the repo root keeps the
// artifact byte-identical no matter where the build is invoked from.
process.chdir(repoRoot);

const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "none",
});
if (!result.success) {
  for (const log of result.logs) process.stderr.write(`${log}\n`);
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

const outfile = resolve(options.outfile);
mkdirSync(dirname(outfile), { recursive: true });
writeFileSync(outfile, output);
chmodSync(outfile, 0o755);

if (options.sizeJson !== undefined) {
  const sizeJson = resolve(options.sizeJson);
  mkdirSync(dirname(sizeJson), { recursive: true });
  writeFileSync(sizeJson, `${JSON.stringify({ bytes: output.byteLength })}\n`);
}
process.stdout.write(`bundle: ${options.outfile} ${output.byteLength} bytes\n`);
