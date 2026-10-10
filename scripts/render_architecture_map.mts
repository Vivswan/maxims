#!/usr/bin/env bun
// The second reader of architecture.yml: the module map, spliced between the
// page's `<!-- BEGIN GENERATED: <name> (hint) -->` and `<!-- END GENERATED: <name> -->`
// markers. A repository's check command runs it with --check so a stale map fails CI.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_CONFIG,
  pathLabel,
  readArchitecture,
  renderArchitectureMermaid,
} from "./arch_lint.mts";
import { parseArgv, type Refuser, usageRefuser } from "./lib/argv.ts";
import { regionBounds } from "./lib/region.ts";

export const DEFAULT_REGION = "architecture-map";

export function spliceMap(text: string, name: string, map: string): string {
  const { bodyStart, bodyEnd } = regionBounds(text, name);
  return `${text.slice(0, bodyStart)}\n\`\`\`mermaid\n${map}\n\`\`\`\n${text.slice(bodyEnd)}`;
}

const USAGE = [
  "usage: bun scripts/render_architecture_map.mts --page <path> [--config <architecture.yml>] [--root <dir>] [--region <name>] [--check]",
  "  --page     the markdown page carrying the generated region",
  "  --config   the layering declaration (default: <root>/architecture.yml)",
  "  --root     the repository root (default: cwd)",
  `  --region   the generated region's name (default: ${DEFAULT_REGION})`,
  "  --check    exit 1 when the committed region differs, instead of rewriting it",
  "exit 0: written or already current; 1: drift under --check; 2: usage, no region, or an unreadable declaration",
].join("\n");

interface CliOptions {
  page: string;
  root: string;
  config: string;
  region: string;
  check: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const refuse: Refuser = usageRefuser(USAGE);
  const { values } = parseArgv(
    {
      args: [...argv],
      options: {
        page: { type: "string" },
        config: { type: "string" },
        root: { type: "string", default: process.cwd() },
        region: { type: "string", default: DEFAULT_REGION },
        check: { type: "boolean", default: false },
      },
    },
    refuse,
  );
  if (values.page === undefined) refuse("--page is required");
  const root = resolve(values.root);
  return {
    page: resolve(values.page),
    root,
    config: values.config === undefined ? join(root, DEFAULT_CONFIG) : resolve(values.config),
    region: values.region,
    check: values.check,
  };
}

if (import.meta.main) {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const pageLabel = pathLabel(options.root, options.page);
  const configLabel = pathLabel(options.root, options.config);
  if (!existsSync(options.page)) {
    console.error(`render-architecture-map: ${pageLabel} does not exist`);
    process.exit(2);
  }
  try {
    const current = readFileSync(options.page, "utf8");
    const map = renderArchitectureMermaid(readArchitecture(options.config, configLabel));
    const next = spliceMap(current, options.region, map);
    if (next === current) {
      console.log(`render-architecture-map: ${pageLabel} region ${options.region} is current`);
    } else if (options.check) {
      console.error(
        `render-architecture-map: ${pageLabel} region ${options.region} differs from ${configLabel}; run without --check to rewrite it`,
      );
      process.exit(1);
    } else {
      writeFileSync(options.page, next);
      console.log(`render-architecture-map: wrote ${pageLabel} region ${options.region}`);
    }
  } catch (error) {
    console.error(
      `render-architecture-map: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
