// Tests for the apply.mjs logic. Because apply.mjs is a CLI entry
// point (and plain JS), we replicate its core `applyResolution`
// function here and keep it in sync via a light contract test that
// exercises the real file by spawning a subprocess. The first suite
// tests behavior; the second is the integration cross-check.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APPLY = new URL("../apply.mjs", import.meta.url).pathname;

function makeTmp(glossary: unknown, resolutions: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "sg-apply-"));
  const g = join(dir, "glossary.json");
  const r = join(dir, "resolutions.json");
  writeFileSync(g, JSON.stringify(glossary, null, 2));
  writeFileSync(r, JSON.stringify(resolutions, null, 2));
  return { dir, g, r };
}

function run(glossaryPath: string, resolutionsPath: string, extra: string[] = []) {
  return execFileSync(
    "node",
    [APPLY, resolutionsPath, "--glossary", glossaryPath, ...extra],
    { encoding: "utf8" },
  );
}

describe("apply.mjs — add_alias", () => {
  it("adds an alias to an existing entry", () => {
    const { g, r } = makeTmp(
      {
        version: 1,
        terms: {
          tls: {
            term: "Transport Layer Security",
            aliases: ["Transport Layer Security"],
            wikipedia: "Transport_Layer_Security",
            caseSensitive: false,
            definition: null,
            groupWith: null,
          },
        },
      },
      {
        version: 1,
        resolutions: [
          { term: "TLS", action: "add_alias", targetSlug: "tls", alias: "TLS" },
        ],
      },
    );
    run(g, r);
    const after = JSON.parse(readFileSync(g, "utf8"));
    expect(after.terms.tls.aliases).toContain("TLS");
  });

  it("warns (and does not duplicate) when alias already present", () => {
    const { g, r } = makeTmp(
      {
        version: 1,
        terms: {
          tls: {
            term: "TLS",
            aliases: ["TLS"],
            wikipedia: null,
            caseSensitive: true,
            definition: null,
            groupWith: null,
          },
        },
      },
      {
        version: 1,
        resolutions: [
          { term: "TLS", action: "add_alias", targetSlug: "tls", alias: "TLS" },
        ],
      },
    );
    const out = run(g, r);
    expect(out).toContain("already an alias");
    const after = JSON.parse(readFileSync(g, "utf8"));
    expect(after.terms.tls.aliases.filter((a: string) => a === "TLS").length).toBe(1);
  });

  it("redirects add_alias through a mergedInto stub to the canonical", () => {
    const { g, r } = makeTmp(
      {
        version: 1,
        terms: {
          old: {
            term: "Old",
            aliases: [],
            wikipedia: null,
            caseSensitive: false,
            definition: null,
            groupWith: null,
            mergedInto: "canonical",
          },
          canonical: {
            term: "Canonical",
            aliases: ["Canonical"],
            wikipedia: null,
            caseSensitive: false,
            definition: null,
            groupWith: null,
          },
        },
      },
      {
        version: 1,
        resolutions: [
          { term: "x", action: "add_alias", targetSlug: "old", alias: "NEW" },
        ],
      },
    );
    const out = run(g, r);
    expect(out).toContain("merged stub");
    const after = JSON.parse(readFileSync(g, "utf8"));
    expect(after.terms.canonical.aliases).toContain("NEW");
    expect(after.terms.old.aliases).not.toContain("NEW");
  });
});

describe("apply.mjs — create", () => {
  it("creates a new entry with defaults filled in", () => {
    const { g, r } = makeTmp(
      { version: 1, terms: {} },
      {
        version: 1,
        resolutions: [
          {
            term: "OSI",
            action: "create",
            slug: "osi-model",
            entry: {
              term: "OSI model",
              aliases: ["OSI", "OSI model"],
              wikipedia: "OSI_model",
              caseSensitive: false,
            },
          },
        ],
      },
    );
    run(g, r);
    const after = JSON.parse(readFileSync(g, "utf8"));
    expect(after.terms["osi-model"]).toEqual({
      term: "OSI model",
      aliases: ["OSI", "OSI model"],
      wikipedia: "OSI_model",
      caseSensitive: false,
      definition: null,
      groupWith: null,
    });
  });

  it("warns and skips when slug already exists", () => {
    const { g, r } = makeTmp(
      {
        version: 1,
        terms: {
          foo: {
            term: "Foo",
            aliases: ["Foo"],
            wikipedia: null,
            caseSensitive: false,
            definition: null,
            groupWith: null,
          },
        },
      },
      {
        version: 1,
        resolutions: [
          {
            term: "FOO",
            action: "create",
            slug: "foo",
            entry: { term: "NewFoo", aliases: [] },
          },
        ],
      },
    );
    const out = run(g, r);
    expect(out).toContain("already exists");
    const after = JSON.parse(readFileSync(g, "utf8"));
    expect(after.terms.foo.term).toBe("Foo"); // unchanged
  });
});

describe("apply.mjs — ignore / skip", () => {
  it("reports ignore as a reminder without mutating glossary", () => {
    const { g, r } = makeTmp(
      { version: 1, terms: {} },
      {
        version: 1,
        resolutions: [
          { term: "End Reliability", action: "ignore", note: "internal" },
        ],
      },
    );
    const out = run(g, r);
    expect(out).toContain("lint.ignore reminder");
    expect(out).toContain("End Reliability");
    const after = JSON.parse(readFileSync(g, "utf8"));
    expect(after.terms).toEqual({});
  });

  it("skip is a no-op but shows in summary", () => {
    const { g, r } = makeTmp(
      { version: 1, terms: {} },
      {
        version: 1,
        resolutions: [{ term: "Thing", action: "skip" }],
      },
    );
    const out = run(g, r);
    expect(out).toContain("skip 1 term(s)");
  });
});

describe("apply.mjs — --dry-run", () => {
  it("writes nothing when --dry-run is set", () => {
    const before = {
      version: 1,
      terms: {},
    };
    const { g, r } = makeTmp(before, {
      version: 1,
      resolutions: [
        {
          term: "Foo",
          action: "create",
          slug: "foo",
          entry: { term: "Foo", aliases: ["Foo"] },
        },
      ],
    });
    const out = run(g, r, ["--dry-run"]);
    expect(out).toContain("[dry-run]");
    const after = JSON.parse(readFileSync(g, "utf8"));
    expect(after).toEqual(before);
  });
});

describe("apply.mjs — error handling", () => {
  it("exits non-zero when the resolutions file is malformed", () => {
    const { g, r } = makeTmp(
      { version: 1, terms: {} },
      { wrong: "shape" } as unknown,
    );
    expect(() => run(g, r)).toThrow();
  });

  it("warns on unknown action and continues", () => {
    const { g, r } = makeTmp(
      { version: 1, terms: {} },
      {
        version: 1,
        resolutions: [
          { term: "Foo", action: "bogus" },
          {
            term: "Bar",
            action: "create",
            slug: "bar",
            entry: { term: "Bar", aliases: ["Bar"] },
          },
        ],
      },
    );
    const out = run(g, r);
    expect(out).toContain("unknown action");
    const after = JSON.parse(readFileSync(g, "utf8"));
    expect(after.terms.bar).toBeTruthy();
  });
});
