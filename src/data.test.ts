import { describe, it, expect } from "vitest";
import {
  joinGlossary,
  resolveSlug,
  type GlossaryCache,
  type GlossaryCacheEntry,
  type GlossaryEntry,
  type GlossaryIndex,
  type ProjectContext,
} from "./data.js";

// --- helpers ---------------------------------------------------------------

function makeEntry(overrides: Partial<GlossaryEntry> = {}): GlossaryEntry {
  return {
    term: "Term",
    aliases: [],
    wikipedia: null,
    caseSensitive: false,
    definition: null,
    groupWith: null,
    ...overrides,
  };
}

function makeIndex(
  terms: Record<string, GlossaryEntry> = {},
): GlossaryIndex {
  return { version: 1, terms };
}

function makeCache(
  terms: Record<string, GlossaryCacheEntry> = {},
): GlossaryCache {
  return { version: 1, fetchedAt: "2024-01-01T00:00:00Z", terms };
}

function makeContext(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    routePrefix: "/glossary",
    wikipediaBase: "https://en.wikipedia.org/wiki/",
    ...overrides,
  };
}

function makeCacheEntry(
  overrides: Partial<GlossaryCacheEntry> = {},
): GlossaryCacheEntry {
  return {
    title: "Title",
    description: "Desc",
    extract_html: "<p>extract</p>",
    url: "https://en.wikipedia.org/wiki/Title",
    ...overrides,
  };
}

// --- joinGlossary: empty index --------------------------------------------

describe("joinGlossary — empty index", () => {
  it("returns empty terms, empty aliasIndex, passes through context", () => {
    const context = makeContext();
    const data = joinGlossary(makeIndex(), makeCache(), context);
    expect(data.terms).toEqual({});
    expect(data.aliasIndex).toBeInstanceOf(Map);
    expect(data.aliasIndex.size).toBe(0);
    expect(data.context).toBe(context);
  });
});

// --- joinGlossary: single entry, no cache match ---------------------------

describe("joinGlossary — single entry without cache match", () => {
  it("runtime entry has cached:null and aliases are lowercased when not case-sensitive", () => {
    const entry = makeEntry({
      term: "TLS",
      aliases: ["TLS", "Transport Layer Security"],
      caseSensitive: false,
    });
    const data = joinGlossary(
      makeIndex({ tls: entry }),
      makeCache(),
      makeContext(),
    );
    expect(data.terms["tls"]).toBeDefined();
    expect(data.terms["tls"]!.cached).toBeNull();
    expect(data.terms["tls"]!.slug).toBe("tls");
    expect(data.aliasIndex.get("tls")).toBe("tls");
    expect(data.aliasIndex.get("transport layer security")).toBe("tls");
    // no uppercase keys present:
    expect(data.aliasIndex.has("TLS")).toBe(false);
    expect(data.aliasIndex.has("Transport Layer Security")).toBe(false);
    expect(data.aliasIndex.size).toBe(2);
  });
});

// --- joinGlossary: single entry with cache --------------------------------

describe("joinGlossary — single entry with cache match", () => {
  it("runtime entry's cached is the cache entry object", () => {
    const cacheEntry = makeCacheEntry({ title: "HPKE" });
    const entry = makeEntry({ term: "HPKE", aliases: ["HPKE"] });
    const data = joinGlossary(
      makeIndex({ hpke: entry }),
      makeCache({ hpke: cacheEntry }),
      makeContext(),
    );
    expect(data.terms["hpke"]!.cached).toBe(cacheEntry);
  });
});

// --- joinGlossary: caseSensitive aliases ----------------------------------

describe("joinGlossary — caseSensitive=true", () => {
  it("keeps exact-case alias key", () => {
    const entry = makeEntry({
      term: "TLS",
      aliases: ["TLS", "SSL"],
      caseSensitive: true,
    });
    const data = joinGlossary(
      makeIndex({ tls: entry }),
      makeCache(),
      makeContext(),
    );
    expect(data.aliasIndex.get("TLS")).toBe("tls");
    expect(data.aliasIndex.get("SSL")).toBe("tls");
    expect(data.aliasIndex.has("tls")).toBe(false);
    expect(data.aliasIndex.has("ssl")).toBe(false);
  });
});

describe("joinGlossary — caseSensitive=false", () => {
  it("lowercases alias keys", () => {
    const entry = makeEntry({
      term: "TLS",
      aliases: ["TLS", "SSL", "MiXeDcAsE"],
      caseSensitive: false,
    });
    const data = joinGlossary(
      makeIndex({ tls: entry }),
      makeCache(),
      makeContext(),
    );
    expect(data.aliasIndex.get("tls")).toBe("tls");
    expect(data.aliasIndex.get("ssl")).toBe("tls");
    expect(data.aliasIndex.get("mixedcase")).toBe("tls");
    // original case keys are NOT present:
    expect(data.aliasIndex.has("TLS")).toBe(false);
    expect(data.aliasIndex.has("SSL")).toBe(false);
    expect(data.aliasIndex.has("MiXeDcAsE")).toBe(false);
  });
});

// --- joinGlossary: merged entries -----------------------------------------

describe("joinGlossary — merged entries", () => {
  it("merged entry is in terms but its aliases are NOT in aliasIndex", () => {
    const canonical = makeEntry({
      term: "Canonical",
      aliases: ["canonical", "canon"],
    });
    const merged = makeEntry({
      term: "Old",
      aliases: ["old", "legacy"],
      mergedInto: "canonical",
    });
    const data = joinGlossary(
      makeIndex({ canonical, old: merged }),
      makeCache(),
      makeContext(),
    );
    // merged entry is still present in terms
    expect(data.terms["old"]).toBeDefined();
    expect(data.terms["old"]!.mergedInto).toBe("canonical");
    expect(data.terms["canonical"]).toBeDefined();

    // canonical aliases ARE indexed
    expect(data.aliasIndex.get("canonical")).toBe("canonical");
    expect(data.aliasIndex.get("canon")).toBe("canonical");

    // merged aliases are NOT indexed
    expect(data.aliasIndex.has("old")).toBe(false);
    expect(data.aliasIndex.has("legacy")).toBe(false);
  });

  it("mergedInto empty-string is treated as non-merged (falsy) — aliases still indexed", () => {
    // Only a non-empty mergedInto counts as merged (truthy check).
    const entry = makeEntry({
      term: "Foo",
      aliases: ["foo"],
      mergedInto: "",
    });
    const data = joinGlossary(
      makeIndex({ foo: entry }),
      makeCache(),
      makeContext(),
    );
    expect(data.terms["foo"]).toBeDefined();
    expect(data.aliasIndex.get("foo")).toBe("foo");
  });

  it("mergedInto null is treated as non-merged", () => {
    const entry = makeEntry({
      term: "Foo",
      aliases: ["foo"],
      mergedInto: null,
    });
    const data = joinGlossary(
      makeIndex({ foo: entry }),
      makeCache(),
      makeContext(),
    );
    expect(data.aliasIndex.get("foo")).toBe("foo");
  });
});

// --- joinGlossary: first-writer-wins --------------------------------------

describe("joinGlossary — first-writer-wins on alias conflict", () => {
  it("first entry in iteration order owns the key; second's conflicts don't overwrite", () => {
    const first = makeEntry({
      term: "First",
      aliases: ["shared", "only-first"],
    });
    const second = makeEntry({
      term: "Second",
      aliases: ["shared", "only-second"],
    });
    const data = joinGlossary(
      makeIndex({ "first-slug": first, "second-slug": second }),
      makeCache(),
      makeContext(),
    );
    // "shared" went to first entry
    expect(data.aliasIndex.get("shared")).toBe("first-slug");
    // each entry's own unique aliases are indexed
    expect(data.aliasIndex.get("only-first")).toBe("first-slug");
    expect(data.aliasIndex.get("only-second")).toBe("second-slug");
  });

  it("multiple conflicts all resolve to first entry", () => {
    const first = makeEntry({
      term: "First",
      aliases: ["a", "b", "c"],
    });
    const second = makeEntry({
      term: "Second",
      aliases: ["a", "b", "c", "d"],
    });
    const data = joinGlossary(
      makeIndex({ one: first, two: second }),
      makeCache(),
      makeContext(),
    );
    expect(data.aliasIndex.get("a")).toBe("one");
    expect(data.aliasIndex.get("b")).toBe("one");
    expect(data.aliasIndex.get("c")).toBe("one");
    // unique alias still goes to second
    expect(data.aliasIndex.get("d")).toBe("two");
  });

  it("iteration-order-dependent: reversing insertion order flips winner", () => {
    // Build index where "second-slug" is inserted first.
    const first = makeEntry({ term: "First", aliases: ["shared"] });
    const second = makeEntry({ term: "Second", aliases: ["shared"] });
    const data = joinGlossary(
      makeIndex({ "second-slug": second, "first-slug": first }),
      makeCache(),
      makeContext(),
    );
    expect(data.aliasIndex.get("shared")).toBe("second-slug");
  });
});

// --- joinGlossary: context passthrough ------------------------------------

describe("joinGlossary — context passthrough", () => {
  it("data.context is strictly === the input context object", () => {
    const context = makeContext({
      routePrefix: "/terms",
      wikipediaBase: "https://example.org/wiki/",
    });
    const data = joinGlossary(makeIndex(), makeCache(), context);
    expect(data.context).toBe(context);
    expect(data.context.routePrefix).toBe("/terms");
    expect(data.context.wikipediaBase).toBe("https://example.org/wiki/");
  });
});

// --- joinGlossary: runtime entry shape ------------------------------------

describe("joinGlossary — runtime entry shape", () => {
  it("preserves all source fields and attaches slug + cached", () => {
    const cacheEntry = makeCacheEntry();
    const entry = makeEntry({
      term: "HPKE",
      aliases: ["HPKE", "Hybrid PKE"],
      wikipedia: "Hybrid_public-key_encryption",
      caseSensitive: true,
      definition: "a hybrid KEM thing",
      groupWith: "crypto",
      aliasFragments: { "TLS 1.3": "TLS_1.3" },
    });
    const data = joinGlossary(
      makeIndex({ hpke: entry }),
      makeCache({ hpke: cacheEntry }),
      makeContext(),
    );
    const rt = data.terms["hpke"]!;
    expect(rt.slug).toBe("hpke");
    expect(rt.term).toBe("HPKE");
    expect(rt.aliases).toEqual(["HPKE", "Hybrid PKE"]);
    expect(rt.wikipedia).toBe("Hybrid_public-key_encryption");
    expect(rt.caseSensitive).toBe(true);
    expect(rt.definition).toBe("a hybrid KEM thing");
    expect(rt.groupWith).toBe("crypto");
    expect(rt.aliasFragments).toEqual({ "TLS 1.3": "TLS_1.3" });
    expect(rt.cached).toBe(cacheEntry);
  });

  it("slug is the first enumerable property (spread order: slug, then entry, then cached)", () => {
    const entry = makeEntry({ term: "Foo", aliases: ["foo"] });
    const data = joinGlossary(
      makeIndex({ foo: entry }),
      makeCache(),
      makeContext(),
    );
    const keys = Object.keys(data.terms["foo"]!);
    expect(keys[0]).toBe("slug");
    // cached appears after entry fields
    expect(keys[keys.length - 1]).toBe("cached");
  });

  it("runtime entry without aliasFragments does not fabricate one", () => {
    const entry = makeEntry({ term: "X", aliases: ["x"] });
    const data = joinGlossary(
      makeIndex({ x: entry }),
      makeCache(),
      makeContext(),
    );
    const rt = data.terms["x"]!;
    // aliasFragments is optional; when the source lacks it, the runtime entry should not have one either.
    expect(rt.aliasFragments).toBeUndefined();
  });
});

// --- joinGlossary: integration shape --------------------------------------

describe("joinGlossary — mixed scenarios", () => {
  it("handles multiple entries with mix of merged/canonical, cached/uncached", () => {
    const cacheA = makeCacheEntry({ title: "A" });
    const data = joinGlossary(
      makeIndex({
        a: makeEntry({ term: "A", aliases: ["a", "alpha"] }),
        b: makeEntry({ term: "B", aliases: ["b"], mergedInto: "a" }),
        c: makeEntry({
          term: "C",
          aliases: ["C", "Gamma"],
          caseSensitive: true,
        }),
      }),
      makeCache({ a: cacheA }),
      makeContext(),
    );

    expect(Object.keys(data.terms).sort()).toEqual(["a", "b", "c"]);
    expect(data.terms["a"]!.cached).toBe(cacheA);
    expect(data.terms["b"]!.cached).toBeNull();
    expect(data.terms["c"]!.cached).toBeNull();

    // a's aliases (lowercase)
    expect(data.aliasIndex.get("a")).toBe("a");
    expect(data.aliasIndex.get("alpha")).toBe("a");
    // b is merged → not indexed
    expect(data.aliasIndex.has("b")).toBe(false);
    // c is case-sensitive → exact-case
    expect(data.aliasIndex.get("C")).toBe("c");
    expect(data.aliasIndex.get("Gamma")).toBe("c");
    expect(data.aliasIndex.has("c")).toBe(false);
    expect(data.aliasIndex.has("gamma")).toBe(false);
  });
});

// --- resolveSlug ----------------------------------------------------------

describe("resolveSlug — non-existent slug", () => {
  it("returns the input unchanged", () => {
    expect(resolveSlug("missing", {})).toBe("missing");
    expect(resolveSlug("missing", { other: { mergedInto: null } })).toBe(
      "missing",
    );
  });
});

describe("resolveSlug — non-merged entry", () => {
  it("returns the input unchanged when entry has no mergedInto", () => {
    const terms = { a: {} };
    expect(resolveSlug("a", terms)).toBe("a");
  });

  it("returns the input unchanged when mergedInto is null", () => {
    const terms = { a: { mergedInto: null } };
    expect(resolveSlug("a", terms)).toBe("a");
  });

  it("returns the input unchanged when mergedInto is empty string (falsy)", () => {
    const terms = { a: { mergedInto: "" } };
    expect(resolveSlug("a", terms)).toBe("a");
  });
});

describe("resolveSlug — single hop", () => {
  it("A → B, resolveSlug('A') returns 'B'", () => {
    const terms = {
      A: { mergedInto: "B" },
      B: { mergedInto: null },
    };
    expect(resolveSlug("A", terms)).toBe("B");
  });
});

describe("resolveSlug — multi-hop chain", () => {
  it("A → B → C returns 'C'", () => {
    const terms = {
      A: { mergedInto: "B" },
      B: { mergedInto: "C" },
      C: { mergedInto: null },
    };
    expect(resolveSlug("A", terms)).toBe("C");
  });

  it("follows a 4-hop chain", () => {
    const terms = {
      a: { mergedInto: "b" },
      b: { mergedInto: "c" },
      c: { mergedInto: "d" },
      d: { mergedInto: null },
    };
    expect(resolveSlug("a", terms)).toBe("d");
  });
});

describe("resolveSlug — cycle protection", () => {
  it("A → B → A does not infinite-loop", () => {
    const terms = {
      A: { mergedInto: "B" },
      B: { mergedInto: "A" },
    };
    // Implementation: while walking A → B, "A" (the start) is already in seen
    // when B.mergedInto = "A" is inspected, so it returns current ("B").
    expect(resolveSlug("A", terms)).toBe("B");
  });

  it("self-loop A → A returns 'A'", () => {
    const terms = { A: { mergedInto: "A" } };
    // seed `seen` has "A"; entry.mergedInto = "A" is already in seen → return current ("A")
    expect(resolveSlug("A", terms)).toBe("A");
  });

  it("3-cycle A → B → C → A returns 'C' (current at the moment cycle is detected)", () => {
    const terms = {
      A: { mergedInto: "B" },
      B: { mergedInto: "C" },
      C: { mergedInto: "A" },
    };
    expect(resolveSlug("A", terms)).toBe("C");
  });

  it("does not hang on a long cycle", () => {
    const terms = {
      a: { mergedInto: "b" },
      b: { mergedInto: "c" },
      c: { mergedInto: "d" },
      d: { mergedInto: "a" },
    };
    // Just check it returns in finite time — value is deterministic per impl,
    // but the key invariant is no infinite loop.
    const out = resolveSlug("a", terms);
    expect(["a", "b", "c", "d"]).toContain(out);
  });
});

describe("resolveSlug — broken chain", () => {
  it("A merged into nonexistent B returns 'B' (last seen target)", () => {
    const terms = { A: { mergedInto: "B" } };
    // A → "B"; current becomes "B"; terms["B"] undefined → return "B"
    expect(resolveSlug("A", terms)).toBe("B");
  });

  it("A → B → nonexistent C returns 'C'", () => {
    const terms = {
      A: { mergedInto: "B" },
      B: { mergedInto: "C" },
      // C is missing
    };
    expect(resolveSlug("A", terms)).toBe("C");
  });
});

describe("resolveSlug — works on full runtime terms", () => {
  it("operates correctly on the `terms` produced by joinGlossary", () => {
    const data = joinGlossary(
      makeIndex({
        old: makeEntry({
          term: "Old",
          aliases: ["old"],
          mergedInto: "new",
        }),
        new: makeEntry({ term: "New", aliases: ["new"] }),
      }),
      makeCache(),
      makeContext(),
    );
    expect(resolveSlug("old", data.terms)).toBe("new");
    expect(resolveSlug("new", data.terms)).toBe("new");
  });
});
