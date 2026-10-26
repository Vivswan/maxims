// An edge is any way one file names another: runtime imports, type-only imports, re-exports,
// `import("./x").T` in a type position, and `import X = require("./x")`. Only relative specifiers
// are edges; a path alias is invisible here, so a graph read through this module names the tree,
// not the alias.
import { dirname } from "node:path";
import { type Node, parseSync, type TemplateElement, Visitor } from "oxc-parser";

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** `node` without its parentheses and `!` wrappers: `(require)("./m")` and `require!("./m")` load like `require("./m")`. */
function unwrapped(node: Node): Node {
  let current = node;
  while (current.type === "ParenthesizedExpression" || current.type === "TSNonNullExpression") {
    current = current.expression;
  }
  return current;
}

/** The string a literal or substitution-free template specifier holds, else undefined. */
function literalSpecifier(node: Node | null | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis
      .map((quasi: TemplateElement) => quasi.value.cooked ?? quasi.value.raw)
      .join("");
  }
  return undefined;
}

/**
 * Every relative specifier `text` names, runtime and type-level alike. A
 * computed `import(x)` or `require(x)` throws, naming file and line: a missing
 * edge is the one failure this lint exists to catch, so the file is rewritten, not skipped.
 */
export function importSpecifiers(text: string, file: string): string[] {
  const { program, errors } = parseSync(file, text);
  const lineOf = (offset: number): number => text.slice(0, offset).split("\n").length;
  const [error] = errors;
  if (error) {
    throw new Error(
      `${file}:${lineOf(error.labels[0]?.start ?? 0)} does not parse: ${error.message}`,
    );
  }
  const found = new Set<string>();
  const computed = (offset: number): never => {
    throw new Error(
      `${file}:${lineOf(offset)} loads a module through a computed specifier, which the import graph cannot follow; use a string literal`,
    );
  };
  // The statements come off the tree, not the parser's module record: that record has no entry
  // for `export {} from "./x"`, which still loads the module.
  new Visitor({
    ImportDeclaration: (node) => void found.add(node.source.value),
    ExportAllDeclaration: (node) => void found.add(node.source.value),
    ExportNamedDeclaration: (node) => {
      if (node.source) found.add(node.source.value);
    },
    ImportExpression: (node) => {
      found.add(literalSpecifier(node.source) ?? computed(node.start));
    },
    CallExpression: (node) => {
      if (isRequireCallee(unwrapped(node.callee))) {
        found.add(literalSpecifier(node.arguments[0]) ?? computed(node.start));
      }
    },
    TSImportType: (node) => void found.add(node.source.value),
    TSExternalModuleReference: (node) => void found.add(node.expression.value),
  }).visit(program);
  return [...found].filter((specifier) => /^\.\.?\//.test(specifier));
}

/** `require(...)` and CommonJS's `module.require(...)` both load; `require.resolve(...)` does not. */
function isRequireCallee(callee: Node): boolean {
  if (callee.type === "Identifier") return callee.name === "require";
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  const { object, property } = callee as unknown as { object: Node; property: Node };
  return (
    object.type === "Identifier" &&
    object.name === "module" &&
    property.type === "Identifier" &&
    property.name === "require"
  );
}

/** Bun.resolveSync takes a directory: handed the importer file itself, it finds nothing. */
export function resolveImport(importer: string, specifier: string): string {
  try {
    return Bun.resolveSync(specifier, dirname(importer));
  } catch (error) {
    if (!(error instanceof ResolveMessage)) throw error;
    throw new Error(`${importer} imports "${specifier}", which resolves to no file`);
  }
}
