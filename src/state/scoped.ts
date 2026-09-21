// The lists state keeps per scope: the user scope's, and one per project root. `disabled` and
// `hooks` share the shape, so one editor normalizes both: an emptied list leaves, an emptied
// object becomes absent, and every list stays sorted and unique, the order the schema refuses to
// read otherwise.
export type ScopeAt = { scope: "global" } | { scope: "project"; root: string };

export type Scoped<T extends string> = {
  global?: T[];
  project?: Record<string, T[]>;
};

export function scopedAt<T extends string>(
  lists: Scoped<T> | undefined,
  at: ScopeAt,
): readonly T[] {
  if (at.scope === "global") return lists?.global ?? [];
  return lists?.project?.[at.root] ?? [];
}

export function withScopedList<T extends string>(
  lists: Scoped<T> | undefined,
  at: ScopeAt,
  next: readonly T[],
): Scoped<T> | undefined {
  const sorted = [...new Set(next)].sort();
  const out: Scoped<T> = { ...lists };
  if (at.scope === "global") {
    if (sorted.length === 0) delete out.global;
    else out.global = sorted;
  } else {
    const project = { ...out.project };
    if (sorted.length === 0) delete project[at.root];
    else project[at.root] = sorted;
    if (Object.keys(project).length === 0) delete out.project;
    else out.project = project;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

// Every scope a set of lists names, the user scope first: what a walk over the lists visits.
export function scopesOf<T extends string>(lists: Scoped<T> | undefined): ScopeAt[] {
  return [
    { scope: "global" },
    ...Object.keys(lists?.project ?? {}).map((root): ScopeAt => ({ scope: "project", root })),
  ];
}
