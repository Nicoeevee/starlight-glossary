import { describe, it, expect, vi } from "vitest";
import remarkGlossary, {
  defaultSlugify,
  type GlossaryReference,
  type RemarkGlossaryOptions,
} from "./remark.js";

// --- helpers ---------------------------------------------------------------

interface LinkNode {
  type: "link";
  url: string;
  children: Array<{ type: "text"; value: string }>;
  data?: { hProperties?: Record<string, unknown> };
}

interface RootNode {
  type: "root";
  children: Array<{
    type: "paragraph";
    children: LinkNode[];
  }>;
}

function makeLink(url: string, label = "Label"): LinkNode {
  return {
    type: "link",
    url,
    children: [{ type: "text", value: label }],
  };
}

function makeTree(...links: LinkNode[]): RootNode {
  return {
    type: "root",
    children: [{ type: "paragraph", children: links }],
  };
}

function run(
  opts: RemarkGlossaryOptions,
  ...links: LinkNode[]
): { tree: RootNode; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn<(ref: GlossaryReference) => void>();
  const transformer = remarkGlossary({ onReference: spy, ...opts });
  const tree = makeTree(...links);
  transformer(tree);
  return { tree, spy };
}

// --- defaultSlugify --------------------------------------------------------

describe("defaultSlugify", () => {
  it("lowercases", () => {
    expect(defaultSlugify("HELLO")).toBe("hello");
  });

  it("converts spaces to hyphens", () => {
    expect(defaultSlugify("hello world")).toBe("hello-world");
  });

  it("converts underscores to hyphens", () => {
    expect(defaultSlugify("Transport_Layer_Security")).toBe(
      "transport-layer-security",
    );
  });

  it("strips accents", () => {
    expect(defaultSlugify("café")).toBe("cafe");
    expect(defaultSlugify("naïve")).toBe("naive");
  });

  it("collapses multiple non-alphanumeric runs to single hyphens", () => {
    expect(defaultSlugify("foo   bar")).toBe("foo-bar");
    expect(defaultSlugify("foo!@#bar")).toBe("foo-bar");
  });

  it("trims leading and trailing hyphens", () => {
    expect(defaultSlugify("---hello---")).toBe("hello");
    expect(defaultSlugify("!!!foo!!!")).toBe("foo");
  });

  it("returns empty string for all-punctuation input", () => {
    expect(defaultSlugify("!!!")).toBe("");
  });
});

// --- label-only references -------------------------------------------------

describe("label-only references", () => {
  it("glossary: derives slug from label via slugify", () => {
    const link = makeLink("glossary:", "Hello World");
    const { tree, spy } = run({}, link);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      slug: "hello-world",
      label: "Hello World",
      slugFromLabel: true,
      article: undefined,
      fragment: undefined,
    });
    const mutated = tree.children[0].children[0];
    expect(mutated.url).toBe("/glossary#hello-world");
    expect(mutated.data?.hProperties?.["data-glossary-term"]).toBe(
      "hello-world",
    );
  });

  it("glossary (no colon) behaves the same as glossary:", () => {
    const link = makeLink("glossary", "Hello World");
    const { tree, spy } = run({}, link);
    expect(spy).toHaveBeenCalledWith({
      slug: "hello-world",
      label: "Hello World",
      slugFromLabel: true,
      article: undefined,
      fragment: undefined,
    });
    expect(tree.children[0].children[0].url).toBe("/glossary#hello-world");
  });

  it("glossary: with whitespace after colon still derives from label", () => {
    const link = makeLink("glossary:   ", "TLS");
    const { tree, spy } = run({}, link);
    expect(spy).toHaveBeenCalledWith({
      slug: "tls",
      label: "TLS",
      slugFromLabel: true,
      article: undefined,
      fragment: undefined,
    });
    expect(tree.children[0].children[0].url).toBe("/glossary#tls");
  });
});

// --- known slugs -----------------------------------------------------------

describe("known slugs", () => {
  it("uses known-slug as-is when knownSlugs contains it", () => {
    const link = makeLink("glossary:known-slug", "Known");
    const known = new Set(["known-slug"]);
    const { tree, spy } = run({ knownSlugs: known }, link);
    expect(spy).toHaveBeenCalledWith({
      slug: "known-slug",
      label: "Known",
      slugFromLabel: false,
      article: undefined,
      fragment: undefined,
    });
    const mutated = tree.children[0].children[0];
    expect(mutated.url).toBe("/glossary#known-slug");
    // known → no --pending class
    expect(mutated.data?.hProperties?.class).toBe("sl-glossary-term");
  });

  it("sets --pending class when slug is not in knownSlugs", () => {
    const link = makeLink("glossary:unseen", "Unseen");
    const known = new Set(["other"]);
    const { tree } = run({ knownSlugs: known }, link);
    const mutated = tree.children[0].children[0];
    expect(mutated.data?.hProperties?.class).toBe(
      "sl-glossary-term sl-glossary-term--pending",
    );
  });

  it("does not set --pending when knownSlugs is undefined", () => {
    const link = makeLink("glossary:anything", "Anything");
    const { tree } = run({}, link);
    const mutated = tree.children[0].children[0];
    expect(mutated.data?.hProperties?.class).toBe("sl-glossary-term");
  });
});

// --- Wikipedia-article-like URL tails --------------------------------------

describe("Wikipedia-article-like URL tails", () => {
  it("glossary:unknown-slug (lowercase-with-hyphens) uses tail as slug AND article", () => {
    const link = makeLink("glossary:unknown-slug", "Unknown");
    const { tree, spy } = run({ knownSlugs: new Set() }, link);
    expect(spy).toHaveBeenCalledWith({
      slug: "unknown-slug",
      label: "Unknown",
      slugFromLabel: false,
      article: "unknown-slug",
      fragment: undefined,
    });
    const mutated = tree.children[0].children[0];
    expect(mutated.url).toBe("/glossary#unknown-slug");
    expect(mutated.data?.hProperties?.class).toBe(
      "sl-glossary-term sl-glossary-term--pending",
    );
  });

  it("glossary:PascalCase slugifies for slug, keeps raw for article", () => {
    const link = makeLink("glossary:PascalCase", "Pascal");
    const { tree, spy } = run({ knownSlugs: new Set() }, link);
    expect(spy).toHaveBeenCalledWith({
      slug: "pascalcase",
      label: "Pascal",
      slugFromLabel: false,
      article: "PascalCase",
      fragment: undefined,
    });
    const mutated = tree.children[0].children[0];
    expect(mutated.url).toBe("/glossary#pascalcase");
    expect(mutated.data?.hProperties?.["data-glossary-term"]).toBe(
      "pascalcase",
    );
  });

  it("glossary:Transport_Layer_Security slugifies to kebab-case", () => {
    const link = makeLink(
      "glossary:Transport_Layer_Security",
      "TLS",
    );
    const { tree, spy } = run({ knownSlugs: new Set() }, link);
    expect(spy).toHaveBeenCalledWith({
      slug: "transport-layer-security",
      label: "TLS",
      slugFromLabel: false,
      article: "Transport_Layer_Security",
      fragment: undefined,
    });
    const mutated = tree.children[0].children[0];
    expect(mutated.url).toBe("/glossary#transport-layer-security");
  });

  it("glossary:Article_With_Parens(stuff) slugifies (parens trigger Wikipedia-article treatment)", () => {
    const link = makeLink("glossary:Cat_(animal)", "cat");
    const { tree, spy } = run({ knownSlugs: new Set() }, link);
    expect(spy).toHaveBeenCalledWith({
      slug: "cat-animal",
      label: "cat",
      slugFromLabel: false,
      article: "Cat_(animal)",
      fragment: undefined,
    });
    expect(tree.children[0].children[0].url).toBe("/glossary#cat-animal");
  });
});

// --- fragments -------------------------------------------------------------

describe("fragments", () => {
  it("glossary:Article#Section captures fragment on article-like URL", () => {
    const link = makeLink(
      "glossary:Transport_Layer_Security#TLS_1.3",
      "TLS 1.3",
    );
    const { tree, spy } = run({ knownSlugs: new Set() }, link);
    expect(spy).toHaveBeenCalledWith({
      slug: "transport-layer-security",
      label: "TLS 1.3",
      slugFromLabel: false,
      article: "Transport_Layer_Security",
      fragment: "TLS_1.3",
    });
    const mutated = tree.children[0].children[0];
    expect(mutated.url).toBe("/glossary#transport-layer-security");
    expect(mutated.data?.hProperties?.["data-glossary-fragment"]).toBe(
      "TLS_1.3",
    );
  });

  it("glossary:known-slug#Section keeps known slug and captures fragment", () => {
    const link = makeLink("glossary:known-slug#Section", "Known");
    const known = new Set(["known-slug"]);
    const { tree, spy } = run({ knownSlugs: known }, link);
    expect(spy).toHaveBeenCalledWith({
      slug: "known-slug",
      label: "Known",
      slugFromLabel: false,
      article: undefined,
      fragment: "Section",
    });
    const mutated = tree.children[0].children[0];
    expect(mutated.url).toBe("/glossary#known-slug");
    expect(mutated.data?.hProperties?.["data-glossary-fragment"]).toBe(
      "Section",
    );
  });

  it("no fragment → no data-glossary-fragment attribute", () => {
    const link = makeLink("glossary:known-slug", "Known");
    const known = new Set(["known-slug"]);
    const { tree } = run({ knownSlugs: known }, link);
    const hProps = tree.children[0].children[0].data?.hProperties ?? {};
    expect("data-glossary-fragment" in hProps).toBe(false);
  });

  it("empty fragment (trailing #) is not stored", () => {
    const link = makeLink("glossary:known-slug#", "Known");
    const known = new Set(["known-slug"]);
    const { tree, spy } = run({ knownSlugs: known }, link);
    expect(spy.mock.calls[0]?.[0].fragment).toBeUndefined();
    const hProps = tree.children[0].children[0].data?.hProperties ?? {};
    expect("data-glossary-fragment" in hProps).toBe(false);
  });
});

// --- redirects -------------------------------------------------------------

describe("redirects", () => {
  it("follows single-step redirect old-slug → new-slug", () => {
    const link = makeLink("glossary:old-slug", "Old");
    const redirects = new Map([["old-slug", "new-slug"]]);
    const known = new Set(["new-slug", "old-slug"]);
    const { tree, spy } = run({ redirects, knownSlugs: known }, link);
    expect(spy.mock.calls[0]?.[0].slug).toBe("new-slug");
    expect(tree.children[0].children[0].url).toBe("/glossary#new-slug");
  });

  it("follows a redirect chain a → b → c", () => {
    const link = makeLink("glossary:a", "A");
    const redirects = new Map([
      ["a", "b"],
      ["b", "c"],
    ]);
    const known = new Set(["a", "b", "c"]);
    const { tree, spy } = run({ redirects, knownSlugs: known }, link);
    expect(spy.mock.calls[0]?.[0].slug).toBe("c");
    expect(tree.children[0].children[0].url).toBe("/glossary#c");
  });

  it("breaks cycles without infinite loop (a → b → a)", () => {
    const link = makeLink("glossary:a", "A");
    const redirects = new Map([
      ["a", "b"],
      ["b", "a"],
    ]);
    const known = new Set(["a", "b"]);
    const { tree, spy } = run({ redirects, knownSlugs: known }, link);
    // cycle protection: should resolve to something in {a,b} without hanging
    const resolved = spy.mock.calls[0]?.[0].slug;
    expect(["a", "b"]).toContain(resolved);
    expect(tree.children[0].children[0].url).toMatch(/^\/glossary#(a|b)$/);
  });

  it("self-cycle (a → a) resolves to a without hanging", () => {
    const link = makeLink("glossary:a", "A");
    const redirects = new Map([["a", "a"]]);
    const { spy } = run({ redirects }, link);
    expect(spy.mock.calls[0]?.[0].slug).toBe("a");
  });

  it("no redirect entry → slug passes through unchanged", () => {
    const link = makeLink("glossary:untouched", "Untouched");
    const redirects = new Map([["other", "something"]]);
    const { spy } = run({ redirects }, link);
    expect(spy.mock.calls[0]?.[0].slug).toBe("untouched");
  });
});

// --- non-glossary links untouched -----------------------------------------

describe("non-glossary links", () => {
  it("leaves https:// links untouched", () => {
    const link = makeLink("https://example.com", "Example");
    const { tree, spy } = run({}, link);
    expect(spy).not.toHaveBeenCalled();
    const mutated = tree.children[0].children[0];
    expect(mutated.url).toBe("https://example.com");
    expect(mutated.data).toBeUndefined();
  });

  it("leaves mailto: links untouched", () => {
    const link = makeLink("mailto:foo@example.com", "Email");
    const { tree, spy } = run({}, link);
    expect(spy).not.toHaveBeenCalled();
    expect(tree.children[0].children[0].url).toBe("mailto:foo@example.com");
  });

  it("leaves relative-path links untouched", () => {
    const link = makeLink("./other-page", "Other");
    const { tree, spy } = run({}, link);
    expect(spy).not.toHaveBeenCalled();
    expect(tree.children[0].children[0].url).toBe("./other-page");
  });

  it("leaves a URL that merely contains 'glossary' untouched", () => {
    const link = makeLink("https://glossary.example.com", "Site");
    const { tree, spy } = run({}, link);
    expect(spy).not.toHaveBeenCalled();
    expect(tree.children[0].children[0].url).toBe(
      "https://glossary.example.com",
    );
  });
});

// --- edge cases ------------------------------------------------------------

describe("edge cases", () => {
  it("empty label → early return, no onReference, no mutation", () => {
    const link: LinkNode = {
      type: "link",
      url: "glossary:",
      children: [{ type: "text", value: "" }],
    };
    const { tree, spy } = run({}, link);
    expect(spy).not.toHaveBeenCalled();
    expect(tree.children[0].children[0].url).toBe("glossary:");
    expect(tree.children[0].children[0].data).toBeUndefined();
  });

  it("whitespace-only label → early return", () => {
    const link: LinkNode = {
      type: "link",
      url: "glossary:",
      children: [{ type: "text", value: "   " }],
    };
    const { tree, spy } = run({}, link);
    expect(spy).not.toHaveBeenCalled();
    expect(tree.children[0].children[0].url).toBe("glossary:");
  });

  it("label differs from slug: slug comes from URL, label kept verbatim", () => {
    const link = makeLink("glossary:transport-layer-security", "TLS");
    const known = new Set(["transport-layer-security"]);
    const { tree, spy } = run({ knownSlugs: known }, link);
    expect(spy).toHaveBeenCalledWith({
      slug: "transport-layer-security",
      label: "TLS",
      slugFromLabel: false,
      article: undefined,
      fragment: undefined,
    });
    expect(tree.children[0].children[0].url).toBe(
      "/glossary#transport-layer-security",
    );
  });

  it("custom routePrefix is used in the rewritten URL", () => {
    const link = makeLink("glossary:foo", "Foo");
    const known = new Set(["foo"]);
    const { tree } = run({ knownSlugs: known, routePrefix: "/terms" }, link);
    expect(tree.children[0].children[0].url).toBe("/terms#foo");
  });

  it("custom slugify is used instead of default", () => {
    const link = makeLink("glossary:", "Hello World");
    const slugify = vi.fn((s: string) => s.replace(/ /g, "_").toLowerCase());
    const { tree, spy } = run({ slugify }, link);
    expect(slugify).toHaveBeenCalledWith("Hello World");
    expect(spy.mock.calls[0]?.[0].slug).toBe("hello_world");
    expect(tree.children[0].children[0].url).toBe("/glossary#hello_world");
  });

  it("custom slugify is applied to Wikipedia-article tails too", () => {
    const link = makeLink("glossary:PascalCase", "Pascal");
    const slugify = (s: string) => `slugified-${s.toLowerCase()}`;
    const { spy } = run({ slugify, knownSlugs: new Set() }, link);
    expect(spy.mock.calls[0]?.[0].slug).toBe("slugified-pascalcase");
    expect(spy.mock.calls[0]?.[0].article).toBe("PascalCase");
  });

  it("works without onReference callback (no throw)", () => {
    const transformer = remarkGlossary({});
    const tree = makeTree(makeLink("glossary:foo", "Foo"));
    expect(() => transformer(tree)).not.toThrow();
    expect(tree.children[0].children[0].url).toBe("/glossary#foo");
  });

  it("preserves pre-existing hProperties when adding glossary attrs", () => {
    const link: LinkNode = {
      type: "link",
      url: "glossary:foo",
      children: [{ type: "text", value: "Foo" }],
      data: { hProperties: { title: "existing", class: "should-override" } },
    };
    const known = new Set(["foo"]);
    const { tree } = run({ knownSlugs: known }, link);
    const hProps = tree.children[0].children[0].data?.hProperties ?? {};
    expect(hProps["title"]).toBe("existing");
    // glossary plugin overrides class
    expect(hProps["class"]).toBe("sl-glossary-term");
    expect(hProps["data-glossary-term"]).toBe("foo");
  });

  it("processes multiple glossary links in one tree", () => {
    const a = makeLink("glossary:foo", "Foo");
    const b = makeLink("glossary:bar", "Bar");
    const c = makeLink("https://ignored", "Ignored");
    const known = new Set(["foo", "bar"]);
    const { tree, spy } = run({ knownSlugs: known }, a, b, c);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(tree.children[0].children[0].url).toBe("/glossary#foo");
    expect(tree.children[0].children[1].url).toBe("/glossary#bar");
    expect(tree.children[0].children[2].url).toBe("https://ignored");
  });

  it("label is trimmed for reference and slug derivation", () => {
    const link = makeLink("glossary:", "  Hello  ");
    const { spy } = run({}, link);
    expect(spy).toHaveBeenCalledWith({
      slug: "hello",
      label: "Hello",
      slugFromLabel: true,
      article: undefined,
      fragment: undefined,
    });
  });
});
