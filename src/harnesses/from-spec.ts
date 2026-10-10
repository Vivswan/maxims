import { basename, dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { realpathOfExistingPrefix } from "../util/fs.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  type HookShape,
  type HookSpec,
  type Scope,
  scopeRoot,
  type Target,
  type TierLayer,
} from "./contract.ts";
import { configDirExists } from "./detect.ts";
import {
  type FrontmatterSpec,
  type GlobalRootSpec,
  type HarnessSpec,
  HOOK_PLACEHOLDERS,
  type HookPlaceholder,
  type HookSpecData,
  homeRelative,
  placeholderPattern,
  placeholdersIn,
  type ScopedFrontmatterSpec,
  type TargetSpec,
} from "./spec.ts";

// The members a spec cannot carry because they are code: a config edit a rules directory needs,
// or a hook the shared writers cannot express. A quirk that needs the compiled paths (a bridge row
// pointing at a file under the resolved global root) is given as a function of the data-only
// definition.
export type HarnessQuirks = {
  configEdit?: HarnessDefinition["configEdit"];
  reconcile?: Extract<HookShape, { kind: "custom" }>["reconcile"];
};
export type QuirksInput = HarnessQuirks | ((declared: HarnessDefinition) => HarnessQuirks);

type ScopedPath = (scope: Scope, ctx: HarnessContext) => string;
type PathsPerScope = Record<Scope, string>;
type LayersSpec = NonNullable<Extract<HookSpecData, { kind: "registry" }>["tierCheck"]>["layers"];

export function toDefinition(spec: HarnessSpec, quirks: QuirksInput = {}): HarnessDefinition {
  const declared = compileData(spec);
  const resolved = typeof quirks === "function" ? quirks(declared) : quirks;
  const { reconcile, configEdit } = resolved;
  if (reconcile !== undefined && declared.hook.kind !== "none") {
    throw new Error(`${spec.id}: a custom reconcile quirk needs hook kind "none" in the spec`);
  }
  return {
    ...declared,
    ...(reconcile === undefined ? {} : { hook: { kind: "custom", reconcile } }),
    ...(configEdit === undefined ? {} : { configEdit }),
  };
}

function compileData(spec: HarnessSpec): HarnessDefinition {
  const globalRoot = spec.globalRoot === undefined ? undefined : compileGlobalRoot(spec.globalRoot);
  const roots: Pick<HarnessDefinition, "globalRoot"> =
    globalRoot === undefined ? {} : { globalRoot };
  const under =
    (paths: PathsPerScope): ScopedPath =>
    (scope, ctx) =>
      join(scopeRoot(roots, scope, ctx), paths[scope]);
  // `dir` is what a trust lookup asks about: a walked layer is trusted per directory, not per project.
  const layered =
    (layers: LayersSpec) =>
    (ctx: HarnessContext): TierLayer[] => {
      const user: TierLayer[] = layers.global.map((path) => ({
        scope: "global",
        path: join(scopeRoot(roots, "global", ctx), path),
      }));
      if (ctx.projectRoot === null) return user;
      const root = scopeRoot(roots, "project", ctx);
      const project: TierLayer[] = layers.project.flatMap((layer) =>
        typeof layer === "string"
          ? [{ scope: "project", path: join(root, layer), dir: root }]
          : directoriesDownTo(root, ctx.cwd).map((dir) => ({
              scope: "project",
              path: join(dir, layer.file),
              dir,
            })),
      );
      return [...project, ...user];
    };
  const scopeFrontmatter = compileScopeFrontmatter(spec.scopeFrontmatter);
  const [first, ...rest] = spec.verifiedAgainst.sources;

  return {
    id: spec.id,
    displayName: spec.displayName,
    tier: spec.tier,
    targets: {
      project: compileTarget(spec.targets.project, spec.displayName),
      global: compileTarget(spec.targets.global, spec.displayName),
    },
    bodiesDir: (scope, ctx) => {
      const dir = spec.bodiesDir[scope];
      return dir === null ? null : join(scopeRoot(roots, scope, ctx), dir);
    },
    hook: compileHook(spec.hook, under, layered),
    markers: spec.markers,
    expands: [...spec.expands],
    ...(spec.byteBudget === undefined ? {} : { byteBudget: spec.byteBudget }),
    detect: (ctx) => {
      const root = globalRoot?.(ctx) ?? ctx.home;
      return (
        (spec.detect.env ?? []).some((name) => ctx.env[name] !== undefined) ||
        spec.detect.dirs.some((dir) => configDirExists(join(root, dir)))
      );
    },
    ...(scopeFrontmatter === undefined ? {} : { scopeFrontmatter }),
    verifiedAgainst: {
      date: spec.verifiedAgainst.date,
      sources: [{ ...first }, ...rest.map((source) => ({ ...source }))],
    },
    ...(spec.fixtures === undefined ? {} : { fixtures: { ...spec.fixtures } }),
    ...roots,
    ...(spec.mcp === undefined
      ? {}
      : {
          mcp: {
            path: (scope, ctx) => {
              const file = spec.mcp?.path[scope];
              return file === null || file === undefined
                ? null
                : join(scopeRoot(roots, scope, ctx), file);
            },
            serversPath: [...spec.mcp.serversPath],
          },
        }),
  };
}

// The nearest layer outranks the ones above it, so the session's own directory comes first. The
// root is recorded by its real path; the session directory climbs from its real path, or the
// climb would pass an aliased root by.
function directoriesDownTo(root: string, cwd: string): string[] {
  const dirs: string[] = [];
  let dir = sessionDirectory(cwd);
  for (;;) {
    dirs.push(dir);
    if (dir === root) return dirs;
    const parent = dirname(dir);
    if (parent === dir) return [root];
    dir = parent;
  }
}

// A prefix nobody may inspect is climbed from the real path of the deepest ancestor that can be,
// the rest kept as typed: the climb still meets a root recorded by its real path, and the probe
// reports the layer that stopped it, where a throw here would abort a verb over files maxims
// never writes.
function sessionDirectory(cwd: string): string {
  const typed = resolve(cwd);
  try {
    return realpathOfExistingPrefix(typed);
  } catch (error) {
    if (!(error instanceof MaximsError)) throw error;
    const parent = dirname(typed);
    return parent === typed ? typed : join(sessionDirectory(parent), basename(typed));
  }
}

// The override is resolved like a shell would resolve a relative `$CODEX_HOME`: against the
// working directory, not against HOME.
function compileGlobalRoot(root: GlobalRootSpec): (ctx: HarnessContext) => string {
  const fallback = homeRelative(root.default);
  const env = root.env;
  return (ctx) => {
    const override = env === undefined ? undefined : ctx.env[env.name];
    if (env !== undefined && override !== undefined && override !== "") {
      return env.subdir === undefined ? resolve(override) : join(resolve(override), env.subdir);
    }
    return join(ctx.home, fallback);
  };
}

function compileTarget(target: TargetSpec | null, displayName: string): Target | null {
  if (target === null) return null;
  if (target.kind === "shared-block") {
    return {
      kind: "shared-block",
      file: target.file,
      ...(target.precedence === undefined ? {} : { precedence: [...target.precedence] }),
      ...(target.skipsEmpty === undefined ? {} : { skipsEmpty: target.skipsEmpty }),
    };
  }
  const frontmatter = target.frontmatter;
  return {
    kind: "rules-dir",
    dir: target.dir,
    fileName: (sourceSlug) => target.fileName.replaceAll("{{slug}}", sourceSlug),
    ...(frontmatter === undefined
      ? {}
      : { frontmatter: compileFrontmatter(frontmatter, displayName) }),
  };
}

// A harness whose always-on file needs a preamble owns the whole preamble, the path filter
// included; without a scoped form a `--paths` install is refused out loud, because writing the
// always-on preamble would install the rules everywhere while the user asked for a subset.
function compileFrontmatter(
  frontmatter: FrontmatterSpec,
  displayName: string,
): (opts: { paths?: string[] }) => string {
  return ({ paths }) => {
    if (paths === undefined || paths.length === 0) return fenced(frontmatter.always);
    if (frontmatter.scoped === undefined) {
      throw new MaximsError(ExitCode.Usage, `${displayName} rules have no path-scoped form`, {
        hint: "drop --paths for this harness",
      });
    }
    return fenced(scopedFields(frontmatter.scoped, paths));
  };
}

function compileScopeFrontmatter(
  scoped: ScopedFrontmatterSpec | undefined,
): HarnessDefinition["scopeFrontmatter"] {
  if (scoped === undefined) return undefined;
  return (globs) => (globs.length === 0 ? null : fenced(scopedFields(scoped, globs)));
}

// Overwriting a key the fields already hold keeps its position, so a `null` placeholder in the
// fields fixes where the paths land.
function scopedFields(scoped: ScopedFrontmatterSpec, paths: string[]): Record<string, unknown> {
  return {
    ...scoped.fields,
    [scoped.pathsKey]: scoped.pathsAs === "list" ? [...paths] : paths.join(","),
  };
}

function fenced(fields: Record<string, unknown>): string {
  return `---\n${stringify(fields)}---\n`;
}

function compileHook(
  hook: HookSpecData,
  under: (paths: PathsPerScope) => ScopedPath,
  layered: (layers: LayersSpec) => (ctx: HarnessContext) => TierLayer[],
): HookShape {
  switch (hook.kind) {
    case "none":
      return { kind: "none" };
    case "file":
      return {
        kind: "file",
        path: under(hook.path),
        render: (hookSpec) => renderText(hook.contentTemplate, placeholderValues(hookSpec)),
        executable: hook.executable,
        stdout: hook.stdout,
      };
    case "registry": {
      const tierCheck = hook.tierCheck;
      return {
        kind: "registry",
        path: under(hook.path),
        format: hook.format,
        eventPath: [...hook.eventPath],
        grouped: hook.grouped,
        ...(hook.wrapper === undefined ? {} : { wrapper: { ...hook.wrapper } }),
        handler: (hookSpec) => renderRecord(hook.handlerTemplate, placeholderValues(hookSpec)),
        commandKey: hook.commandKey,
        stdout: hook.stdout,
        async: hook.async,
        ...(hook.debounceMs === undefined ? {} : { debounceMs: hook.debounceMs }),
        ...(tierCheck === undefined
          ? {}
          : {
              tierCheck: {
                layers: layered(tierCheck.layers),
                format: tierCheck.format ?? hook.format,
                key: tierCheck.key,
                demotesWhen: tierCheck.demotesWhen,
                unreadable: tierCheck.unreadable,
                ...(tierCheck.projectTrust === undefined
                  ? {}
                  : {
                      projectTrust: {
                        ...tierCheck.projectTrust,
                        accepted: [...tierCheck.projectTrust.accepted],
                      },
                    }),
              },
            }),
      };
    }
  }
}

type PlaceholderValues = Record<HookPlaceholder, string | boolean | number | string[]>;

function placeholderValues(spec: HookSpec): PlaceholderValues {
  const argv = [spec.command, ...spec.args];
  return {
    command: argv.join(" "),
    argv,
    async: spec.async,
    timeoutSeconds: spec.timeoutSeconds,
    timeoutMs: spec.timeoutSeconds * 1000,
  };
}

// The schema has already refused every placeholder outside the known set, so an unknown name here
// is a spec that bypassed parsing; it is a programming error, not a user-facing one.
function placeholderValue(
  values: PlaceholderValues,
  name: string,
): PlaceholderValues[HookPlaceholder] {
  const known = HOOK_PLACEHOLDERS.find((candidate) => candidate === name);
  if (known === undefined) throw new Error(`unknown template placeholder {{${name}}}`);
  return values[known];
}

function renderText(template: string, values: PlaceholderValues): string {
  return template.replaceAll(placeholderPattern(), (_, name: string) => {
    const value = placeholderValue(values, name);
    return Array.isArray(value) ? JSON.stringify(value) : String(value);
  });
}

function renderValue(template: unknown, values: PlaceholderValues): unknown {
  if (typeof template === "string") {
    const names = placeholdersIn(template);
    const [only] = names;
    if (names.length === 1 && only !== undefined && template === `{{${only}}}`) {
      const value = placeholderValue(values, only);
      return Array.isArray(value) ? [...value] : value;
    }
    return renderText(template, values);
  }
  if (Array.isArray(template)) return template.map((item) => renderValue(item, values));
  if (typeof template === "object" && template !== null) return renderRecord(template, values);
  return template;
}

function renderRecord(template: object, values: PlaceholderValues): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(template).map(([key, value]) => [key, renderValue(value, values)]),
  );
}
