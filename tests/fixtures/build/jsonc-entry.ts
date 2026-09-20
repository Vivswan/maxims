// Bundle entry for tests/build.test.ts: the smallest program that loads jsonc-parser through
// src/util/jsonc.ts, so the shipped artifact's copy of the dependency is what runs under node.
import { appendChild, assertParses } from "../../../src/util/jsonc.ts";

const text = '{"a": 1}';
process.stdout.write(`jsonc: ${appendChild(text, assertParses(text, "fixture.json"), "b", 2)}\n`);
