// What would drift silently: a hook whose stdin read blocks a session start (an open pipe with no
// EOF, a terminal), a JSON-only harness receiving plain text, a payload cut mid-way returned as a
// value, and a source slug two sources can share.
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { HookStdout } from "../../harnesses/contract.ts";
import { sourceSlug } from "./slug.ts";
import { classifyInvoker, readHookStdin, renderHookStdout } from "./stdin.ts";

describe("readHookStdin", () => {
  test("a terminal is never read: no listener is attached and the answer is immediate", async () => {
    const stream = new PassThrough();
    Object.assign(stream, { isTTY: true });
    const read = readHookStdin(stream, 50);
    expect(stream.listenerCount("data")).toBe(0);
    expect(stream.listenerCount("end")).toBe(0);
    expect(await read).toBeNull();
  });

  test("a pipe that never closes still yields the payload once it parses, and null when nothing arrives", async () => {
    const open = new PassThrough();
    const read = readHookStdin(open, 50);
    open.write('{"hook_event_name":');
    open.write('"SessionStart","cwd":"/home/user"}');
    expect(await read).toBe('{"hook_event_name":"SessionStart","cwd":"/home/user"}');
    const silent = new PassThrough();
    expect(await readHookStdin(silent, 20)).toBeNull();
  });

  test("a pipe that fails before any text is an unknown invoker, not a terminal", async () => {
    const stream = new PassThrough();
    const read = readHookStdin(stream, 50);
    stream.emit("error", new Error("EPIPE"));
    const text = await read;
    expect(text).not.toBeNull();
    expect(classifyInvoker(text)).toEqual({ kind: "unknown-json" });
  });

  test("a closed pipe carrying non-JSON hands the text back for classification", async () => {
    const stream = new PassThrough();
    const read = readHookStdin(stream, 50);
    stream.end("not json");
    expect(await read).toBe("not json");
    expect(classifyInvoker("not json")).toEqual({ kind: "unknown-json" });
  });

  test("a multi-byte character split across chunks is decoded whole", async () => {
    const stream = new PassThrough();
    const read = readHookStdin(stream, 50);
    const bytes = Buffer.from(
      JSON.stringify({
        hook_event_name: "sessionStart",
        workspace_roots: ["/home/user/caf\u00e9"],
      }),
    );
    const cut = bytes.indexOf(Buffer.from("\u00e9")) + 1;
    stream.write(bytes.subarray(0, cut));
    stream.write(bytes.subarray(cut));
    const text = await read;
    expect(classifyInvoker(text)).toEqual({
      kind: "harness",
      id: "cursor",
      startDir: "/home/user/caf\u00e9",
    });
  });
});

describe("renderHookStdout", () => {
  const line = "maxims: @acme/rules offline";
  const cases: [HookStdout | null, string][] = [
    ["plain", `${line}\n`],
    ["json:additionalContext", `{"additionalContext":"${line}"}\n`],
    [
      "json:hookSpecificOutput.additionalContext",
      `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"${line}"}}\n`,
    ],
    ["json:contextModification", `{"cancel":false,"contextModification":"${line}"}\n`],
    ["json:additional_context", `{"additional_context":"${line}"}\n`],
    ["none", ""],
    [null, ""],
  ];
  for (const [variant, expected] of cases) {
    test(`${variant} renders the documented envelope`, () => {
      expect(renderHookStdout(variant, [line])).toBe(expected);
      expect(renderHookStdout(variant, [])).toBe("");
    });
  }
});

describe("sourceSlug", () => {
  test("readable for a plain owner/repo, hash-suffixed when two keys could read alike", () => {
    expect(sourceSlug({ type: "github", repo: "Example/skills", ref: "HEAD" })).toBe(
      "example-skills",
    );
    const dashed = [
      sourceSlug({ type: "github", repo: "acme/foo-bar", ref: "HEAD" }),
      sourceSlug({ type: "github", repo: "acme-foo/bar", ref: "HEAD" }),
      sourceSlug({ type: "github", repo: "acme/foo_bar", ref: "HEAD" }),
    ];
    expect(new Set(dashed).size).toBe(3);
    for (const slug of dashed) expect(slug).toMatch(/^acme-foo-bar--[0-9a-f]+$/);
    const pinned = sourceSlug({ type: "github", repo: "acme/rules", ref: "v2" });
    expect(pinned).toMatch(/^acme-rules-v2--[0-9a-f]+$/);
    expect(pinned).not.toBe(sourceSlug({ type: "github", repo: "acme/rules-v2", ref: "HEAD" }));
    const git = sourceSlug({
      type: "git",
      url: "https://git.example.com/team/rules.git",
      ref: "HEAD",
    });
    expect(git).toMatch(/^git-example-com-team-rules--[0-9a-f]+$/);
    expect(git).not.toBe(
      sourceSlug({ type: "git", url: "https://git.example.com:8443/team/rules", ref: "HEAD" }),
    );
    const plus = sourceSlug({
      type: "git",
      url: "https://git.example.com/team/my+rules",
      ref: "HEAD",
    });
    expect(plus).toMatch(/^git-example-com-team-my-rules--[0-9a-f]+$/);
    const longPin = sourceSlug({ type: "github", repo: "acme/rules", ref: "v".repeat(230) });
    expect(`maxims-${longPin}.md`.length).toBeLessThan(120);
    expect(longPin).not.toBe(
      sourceSlug({ type: "github", repo: "acme/rules", ref: "v".repeat(231) }),
    );
    const punctuation = sourceSlug({ type: "local", path: "/home/user/___" });
    expect(punctuation).toContain("--");
    expect(punctuation).not.toBe(sourceSlug({ type: "github", repo: "local/cff286", ref: "HEAD" }));
    const local = sourceSlug({ type: "local", path: "/home/user/memories" });
    expect(local).toMatch(/^local-memories--[0-9a-f]+$/);
    expect(local).not.toBe(sourceSlug({ type: "local", path: "/home/user/work/memories" }));
    expect(local).not.toBe(sourceSlug({ type: "github", repo: "memories/01727f", ref: "HEAD" }));
  });
});
