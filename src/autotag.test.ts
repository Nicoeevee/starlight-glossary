import { describe, it, expect } from "vitest";
import { buildMatcher, remarkAutoTag, type AutoTagMode } from "./autotag.js";
import {
  joinGlossary,
  type GlossaryCache,
  type GlossaryData,
  type GlossaryEntry,
  type GlossaryIndex,
  type ProjectContext,
} from "./data.js";

// --- helpers ---------------------------------------------------------------

const CTX: ProjectContext = {
  routePrefix: "/glossary",
  wikipediaBase: "https://en.wikipedia.org/wiki/",
};

const EMPTY_CACHE: GlossaryCache = {
  version: 1,
  fetchedAt: "",
  terms: {},
};

function makeEntry(partial: Partial<GlossaryEntry> & { term: string }): GlossaryEntry {
  return {
    term: partial.term,
    aliases: partial.aliases ?? [partial.term],
    wikipedia: partial.wikipedia ?? null,
    caseSensitive: partial.caseSensitive ?? false,
    definition: partial.definition ?? null,
    groupWith: partial.groupWith ?? null,
    mergedInto: partial.mergedInto ?? null,
    aliasFragments: partial.aliasFragments,
  };
}

function makeData(
  terms: Record<string, GlossaryEntry>,
  context: ProjectContext = CTX,
): GlossaryData {
  const index: GlossaryIndex = { version: 1, terms };
  return joinGlossary(index, EMPTY_CACHE, context);
}

interface TextNode {
  type: "text";
  value: string;
}

interface HtmlNode {
  type: "html";
  value: string;
}

type AnyNode = TextNode | HtmlNode | { type: string; children?: AnyNode[]; value?: string };

function text(value: string): TextNode {
  return { type: "text", value };
}

function paragraph(...children: AnyNode[]) {
  return { type: "paragraph", children };
}

function root(...children: AnyNode[]) {
  return { type: "root", children };
}

function run(
  data: GlossaryData,
  mode: AutoTagMode,
  tree: AnyNode,
  routePrefix = "/glossary",
) {
  const transformer = remarkAutoTag({ mode, routePrefix, data });
  transformer(tree);
  return tree;
}

function firstChild(tree: AnyNode, ...path: number[]): AnyNode {
  let cur: AnyNode = tree;
  for (const i of path) {
    if (!cur || !("children" in cur) || !cur.children) {
      throw new Error("bad path");
    }
    cur = cur.children[i];
  }
  return cur;
}

// --- buildMatcher ----------------------------------------------------------

describe("buildMatcher", () => {
  it("returns null regexes for empty data", () => {
    const data = makeData({});
    const m = buildMatcher(data);
    expect(m.caseSensitiveRe).toBeNull();
    expect(m.caseInsensitiveRe).toBeNull();
    expect(m.aliasToSlug.size).toBe(0);
    expect(m.aliasToSlugCi.size).toBe(0);
    expect(m.aliasFragment.size).toBe(0);
  });

  it("puts case-sensitive aliases into caseSensitiveRe and aliasToSlug", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: true }),
    });
    const m = buildMatcher(data);
    expect(m.caseSensitiveRe).not.toBeNull();
    expect(m.caseInsensitiveRe).toBeNull();
    expect(m.aliasToSlug.get("TLS")).toBe("tls");
    expect(m.aliasToSlugCi.size).toBe(0);
  });

  it("puts case-insensitive aliases into caseInsensitiveRe and aliasToSlugCi (lowercased key)", () => {
    const data = makeData({
      tls: makeEntry({
        term: "TLS",
        aliases: ["TLS", "Transport Layer Security"],
        caseSensitive: false,
      }),
    });
    const m = buildMatcher(data);
    expect(m.caseInsensitiveRe).not.toBeNull();
    expect(m.caseSensitiveRe).toBeNull();
    expect(m.aliasToSlugCi.get("tls")).toBe("tls");
    expect(m.aliasToSlugCi.get("transport layer security")).toBe("tls");
  });

  it("skips merged entries entirely", () => {
    const data = makeData({
      old: makeEntry({
        term: "Old",
        aliases: ["OldName", "oldname"],
        caseSensitive: false,
        mergedInto: "canonical",
      }),
      canonical: makeEntry({
        term: "Canonical",
        aliases: ["Canonical"],
        caseSensitive: false,
      }),
    });
    const m = buildMatcher(data);
    expect(m.aliasToSlugCi.get("oldname")).toBeUndefined();
    expect(m.aliasToSlugCi.get("canonical")).toBe("canonical");
    // regex must not match "OldName"
    expect("OldName".match(m.caseInsensitiveRe!)).toBeNull();
  });

  it("aliasFragments: case-sensitive entry stores only the original key", () => {
    const data = makeData({
      tls: makeEntry({
        term: "TLS",
        aliases: ["TLS"],
        caseSensitive: true,
        aliasFragments: { "TLS 1.3": "TLS_1.3" },
      }),
    });
    const m = buildMatcher(data);
    expect(m.aliasFragment.get("TLS 1.3")).toBe("TLS_1.3");
    expect(m.aliasFragment.get("tls 1.3")).toBeUndefined();
  });

  it("aliasFragments: case-insensitive entry stores both original and lowercased keys", () => {
    const data = makeData({
      tls: makeEntry({
        term: "TLS",
        aliases: ["TLS"],
        caseSensitive: false,
        aliasFragments: { "TLS 1.3": "TLS_1.3" },
      }),
    });
    const m = buildMatcher(data);
    expect(m.aliasFragment.get("TLS 1.3")).toBe("TLS_1.3");
    expect(m.aliasFragment.get("tls 1.3")).toBe("TLS_1.3");
  });

  it("sorts aliases longest-first so long alternative wins in regex", () => {
    const data = makeData({
      hpke: makeEntry({
        term: "HPKE",
        aliases: ["HPKE", "Hybrid Public Key Encryption"],
        caseSensitive: false,
      }),
    });
    const m = buildMatcher(data);
    // regex source has the longer string appearing before "HPKE"
    const src = m.caseInsensitiveRe!.source;
    const longIdx = src.indexOf("Hybrid Public Key Encryption");
    const shortIdx = src.indexOf("HPKE");
    expect(longIdx).toBeGreaterThanOrEqual(0);
    expect(shortIdx).toBeGreaterThanOrEqual(0);
    expect(longIdx).toBeLessThan(shortIdx);
  });
});

// --- remarkAutoTag ---------------------------------------------------------

describe("remarkAutoTag — mode: off", () => {
  it("does nothing regardless of matches", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const tree = root(paragraph(text("I use TLS daily")));
    run(data, "off", tree);
    const para = firstChild(tree, 0);
    expect(para.type).toBe("paragraph");
    const t = firstChild(tree, 0, 0);
    expect(t.type).toBe("text");
    expect((t as TextNode).value).toBe("I use TLS daily");
  });

  it("empty data + off is a safe no-op", () => {
    const data = makeData({});
    const tree = root(paragraph(text("hello")));
    expect(() => run(data, "off", tree)).not.toThrow();
    expect((firstChild(tree, 0, 0) as TextNode).value).toBe("hello");
  });
});

describe("remarkAutoTag — empty data", () => {
  it("all mode with empty data: transformer is a no-op", () => {
    const data = makeData({});
    const tree = root(paragraph(text("I use TLS daily")));
    run(data, "all", tree);
    const t = firstChild(tree, 0, 0);
    expect(t.type).toBe("text");
    expect((t as TextNode).value).toBe("I use TLS daily");
  });
});

describe("remarkAutoTag — case-insensitive match", () => {
  it("lowercases in the text are matched; displayed text preserves original case", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const tree = root(paragraph(text("I use tls daily")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.type).toBe("html");
    expect(n.value).toBe(
      "I use " +
        '<a href="/glossary#tls" data-glossary-term="tls" ' +
        'class="sl-glossary-term sl-glossary-term--auto">tls</a>' +
        " daily",
    );
  });

  it("uppercase version also matches when caseSensitive=false", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const tree = root(paragraph(text("I use TLS daily")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.type).toBe("html");
    expect(n.value).toContain(">TLS</a>");
  });
});

describe("remarkAutoTag — case-sensitive acronym", () => {
  it("lowercase text does NOT match", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: true }),
    });
    const tree = root(paragraph(text("I use tls daily")));
    run(data, "all", tree);
    const t = firstChild(tree, 0, 0);
    expect(t.type).toBe("text");
    expect((t as TextNode).value).toBe("I use tls daily");
  });

  it("exact-case text DOES match", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: true }),
    });
    const tree = root(paragraph(text("I use TLS daily")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.type).toBe("html");
    expect(n.value).toContain(
      '<a href="/glossary#tls" data-glossary-term="tls" ' +
        'class="sl-glossary-term sl-glossary-term--auto">TLS</a>',
    );
  });
});

describe("remarkAutoTag — mode: first", () => {
  it("only tags the first occurrence of each slug across the tree", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const p1 = paragraph(text("First mention: TLS here"));
    const p2 = paragraph(text("Second mention: TLS there"));
    const tree = root(p1, p2);
    run(data, "first", tree);

    const first = firstChild(tree, 0, 0);
    const second = firstChild(tree, 1, 0);
    expect(first.type).toBe("html");
    expect((first as HtmlNode).value).toContain(">TLS</a>");
    // second stays as plain text
    expect(second.type).toBe("text");
    expect((second as TextNode).value).toBe("Second mention: TLS there");
  });

  it("different slugs each get their own 'first' tag", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
      hpke: makeEntry({ term: "HPKE", aliases: ["HPKE"], caseSensitive: false }),
    });
    const p1 = paragraph(text("Once: TLS"));
    const p2 = paragraph(text("Once: HPKE"));
    const p3 = paragraph(text("Twice: TLS again"));
    const tree = root(p1, p2, p3);
    run(data, "first", tree);

    expect(firstChild(tree, 0, 0).type).toBe("html");
    expect(firstChild(tree, 1, 0).type).toBe("html");
    // third still text (TLS already tagged)
    expect(firstChild(tree, 2, 0).type).toBe("text");
  });
});

describe("remarkAutoTag — mode: all", () => {
  it("tags every occurrence across text nodes", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const p1 = paragraph(text("First mention: TLS here"));
    const p2 = paragraph(text("Second mention: TLS there"));
    const tree = root(p1, p2);
    run(data, "all", tree);
    expect(firstChild(tree, 0, 0).type).toBe("html");
    expect(firstChild(tree, 1, 0).type).toBe("html");
    expect((firstChild(tree, 0, 0) as HtmlNode).value).toContain(">TLS</a>");
    expect((firstChild(tree, 1, 0) as HtmlNode).value).toContain(">TLS</a>");
  });
});

describe("remarkAutoTag — longer alias wins", () => {
  it("Hybrid Public Key Encryption (whole phrase) is tagged, not just HPKE", () => {
    const data = makeData({
      hpke: makeEntry({
        term: "HPKE",
        aliases: ["HPKE", "Hybrid Public Key Encryption"],
        caseSensitive: false,
      }),
    });
    const tree = root(paragraph(text("We use Hybrid Public Key Encryption here")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.type).toBe("html");
    // exactly one anchor
    const anchorCount = (n.value.match(/<a /g) ?? []).length;
    expect(anchorCount).toBe(1);
    // anchor wraps the long phrase
    expect(n.value).toContain(
      ">Hybrid Public Key Encryption</a>",
    );
  });

  it("short alias still matches when long one isn't present", () => {
    const data = makeData({
      hpke: makeEntry({
        term: "HPKE",
        aliases: ["HPKE", "Hybrid Public Key Encryption"],
        caseSensitive: false,
      }),
    });
    const tree = root(paragraph(text("Just HPKE alone")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.value).toContain(">HPKE</a>");
  });
});

describe("remarkAutoTag — word boundary", () => {
  it("HTTP does not match inside HTTPS", () => {
    const data = makeData({
      http: makeEntry({ term: "HTTP", aliases: ["HTTP"], caseSensitive: false }),
    });
    const tree = root(paragraph(text("We use HTTPS only")));
    run(data, "all", tree);
    const t = firstChild(tree, 0, 0);
    expect(t.type).toBe("text");
    expect((t as TextNode).value).toBe("We use HTTPS only");
  });

  it("HTTP at word boundary does match", () => {
    const data = makeData({
      http: makeEntry({ term: "HTTP", aliases: ["HTTP"], caseSensitive: false }),
    });
    const tree = root(paragraph(text("We use HTTP only")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.type).toBe("html");
    expect(n.value).toContain(">HTTP</a>");
  });
});

describe("remarkAutoTag — multiple matches in one text node", () => {
  it("emits two anchors with correct surrounding text", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
      hpke: makeEntry({ term: "HPKE", aliases: ["HPKE"], caseSensitive: false }),
    });
    const tree = root(paragraph(text("TLS and HPKE both matter")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.type).toBe("html");
    const anchors = (n.value.match(/<a /g) ?? []).length;
    expect(anchors).toBe(2);
    expect(n.value).toContain(">TLS</a>");
    expect(n.value).toContain(">HPKE</a>");
    expect(n.value).toContain("</a> and <a");
    expect(n.value.endsWith(" both matter")).toBe(true);
  });
});

describe("remarkAutoTag — parent type allow-list", () => {
  it("text inside a paragraph is tagged", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const tree = root(paragraph(text("TLS here")));
    run(data, "all", tree);
    expect(firstChild(tree, 0, 0).type).toBe("html");
  });

  it("text inside a heading is NOT tagged", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const heading = { type: "heading", depth: 2, children: [text("About TLS")] };
    const tree = root(heading as AnyNode);
    run(data, "all", tree);
    const t = firstChild(tree, 0, 0);
    expect(t.type).toBe("text");
    expect((t as TextNode).value).toBe("About TLS");
  });

  it("text inside a link is NOT tagged (link not on allow-list)", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const link = { type: "link", url: "https://example.com", children: [text("TLS")] };
    const tree = root(paragraph(link as AnyNode));
    run(data, "all", tree);
    const t = firstChild(tree, 0, 0, 0);
    expect(t.type).toBe("text");
    expect((t as TextNode).value).toBe("TLS");
  });

  it("text inside listItem > paragraph is tagged (paragraph is safe)", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const innerPara = paragraph(text("TLS item"));
    const listItem = { type: "listItem", children: [innerPara] };
    const list = { type: "list", ordered: false, children: [listItem] };
    const tree = root(list as AnyNode);
    run(data, "all", tree);
    const t = firstChild(tree, 0, 0, 0, 0);
    expect(t.type).toBe("html");
    expect((t as HtmlNode).value).toContain(">TLS</a>");
  });

  it("text inside a listItem directly is tagged (listItem on allow-list)", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const listItem = { type: "listItem", children: [text("TLS direct")] };
    const list = { type: "list", ordered: false, children: [listItem] };
    const tree = root(list as AnyNode);
    run(data, "all", tree);
    const t = firstChild(tree, 0, 0, 0);
    expect(t.type).toBe("html");
  });

  it("text inside an mdxJsxFlowElement is NOT tagged (allow-list miss)", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const mdx = {
      type: "mdxJsxFlowElement",
      name: "Something",
      attributes: [],
      children: [text("I use TLS here")],
    };
    const tree = root(mdx as AnyNode);
    run(data, "all", tree);
    const t = firstChild(tree, 0, 0);
    expect(t.type).toBe("text");
    expect((t as TextNode).value).toBe("I use TLS here");
  });

  it("text inside emphasis is tagged (emphasis on allow-list)", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const em = { type: "emphasis", children: [text("TLS")] };
    const tree = root(paragraph(em as AnyNode));
    run(data, "all", tree);
    const t = firstChild(tree, 0, 0, 0);
    expect(t.type).toBe("html");
  });

  it("text inside strong is tagged", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const strong = { type: "strong", children: [text("TLS")] };
    const tree = root(paragraph(strong as AnyNode));
    run(data, "all", tree);
    const t = firstChild(tree, 0, 0, 0);
    expect(t.type).toBe("html");
  });
});

describe("remarkAutoTag — merged entry", () => {
  it("aliases of merged entries never appear in matcher and are never tagged", () => {
    const data = makeData({
      old: makeEntry({
        term: "OldName",
        aliases: ["OldName"],
        caseSensitive: false,
        mergedInto: "canonical",
      }),
      canonical: makeEntry({
        term: "Canonical",
        aliases: ["Canonical"],
        caseSensitive: false,
      }),
    });
    const tree = root(paragraph(text("Remember OldName was around")));
    run(data, "all", tree);
    const t = firstChild(tree, 0, 0);
    expect(t.type).toBe("text");
    expect((t as TextNode).value).toBe("Remember OldName was around");
  });

  it("canonical target still matches when both entries exist", () => {
    const data = makeData({
      old: makeEntry({
        term: "OldName",
        aliases: ["OldName"],
        caseSensitive: false,
        mergedInto: "canonical",
      }),
      canonical: makeEntry({
        term: "Canonical",
        aliases: ["Canonical"],
        caseSensitive: false,
      }),
    });
    const tree = root(paragraph(text("Canonical is still here")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.type).toBe("html");
    expect(n.value).toContain('data-glossary-term="canonical"');
  });
});

describe("remarkAutoTag — aliasFragments", () => {
  it("emits data-glossary-fragment attr when match has a registered fragment", () => {
    const data = makeData({
      tls: makeEntry({
        term: "TLS",
        aliases: ["TLS", "TLS 1.3"],
        caseSensitive: false,
        aliasFragments: { "TLS 1.3": "TLS_1.3" },
      }),
    });
    const tree = root(paragraph(text("Ship TLS 1.3 already")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.type).toBe("html");
    expect(n.value).toContain('data-glossary-fragment="TLS_1.3"');
    expect(n.value).toContain(">TLS 1.3</a>");
  });

  it("no data-glossary-fragment for plain matches without a registered fragment", () => {
    const data = makeData({
      tls: makeEntry({
        term: "TLS",
        aliases: ["TLS", "TLS 1.3"],
        caseSensitive: false,
        aliasFragments: { "TLS 1.3": "TLS_1.3" },
      }),
    });
    const tree = root(paragraph(text("Use TLS always")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.value).not.toContain("data-glossary-fragment");
  });

  it("aliasFragments case-insensitive lookup: lowercase match text still finds the fragment", () => {
    const data = makeData({
      tls: makeEntry({
        term: "TLS",
        aliases: ["TLS", "TLS 1.3"],
        caseSensitive: false,
        aliasFragments: { "TLS 1.3": "TLS_1.3" },
      }),
    });
    // match the lowercase version; buildMatcher duplicates fragment into lowercased key
    const tree = root(paragraph(text("Ship tls 1.3 already")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.value).toContain('data-glossary-fragment="TLS_1.3"');
  });
});

describe("remarkAutoTag — HTML/attr escaping", () => {
  it("escapes < in non-match surrounding text", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const tree = root(paragraph(text("<unsafe> TLS <bad>")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.value).toContain("&lt;unsafe&gt;");
    expect(n.value).toContain("&lt;bad&gt;");
    // no raw unescaped < outside of the generated anchor tag
    // the anchor itself is intentionally raw HTML
    expect(n.value.startsWith("&lt;unsafe&gt; ")).toBe(true);
    expect(n.value.endsWith(" &lt;bad&gt;")).toBe(true);
  });

  it("escapes & in non-match text", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const tree = root(paragraph(text("A & B TLS C & D")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.value.startsWith("A &amp; B ")).toBe(true);
    expect(n.value.endsWith(" C &amp; D")).toBe(true);
  });

  it("escapes special characters in alias slug/display", () => {
    // Defensive: if an alias somehow contained <, &, or ", the output must escape.
    const data = makeData({
      weird: makeEntry({
        term: "A&B",
        aliases: ["A&B"],
        caseSensitive: false,
      }),
    });
    const tree = root(paragraph(text("Look at A&B here")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.type).toBe("html");
    // The displayed text inside the anchor gets HTML-escaped
    expect(n.value).toContain(">A&amp;B</a>");
    // The slug, which is the raw key, gets attribute-escaped
    expect(n.value).toContain('data-glossary-term="weird"');
  });

  it("escapes quote characters in fragment attribute", () => {
    const data = makeData({
      tls: makeEntry({
        term: "TLS",
        aliases: ["TLS", "TLS 1.3"],
        caseSensitive: false,
        aliasFragments: { "TLS 1.3": 'odd"quote' },
      }),
    });
    const tree = root(paragraph(text("TLS 1.3 here")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.value).toContain('data-glossary-fragment="odd&quot;quote"');
  });
});

describe("remarkAutoTag — overlapping matches", () => {
  it("first (by start index) match wins; overlapping second is dropped", () => {
    // "Public Key" matches first alias; "Key Encryption" would overlap with the
    // tail; since matches are sorted by start and non-overlapping picked, the
    // first one wins.
    const data = makeData({
      a: makeEntry({
        term: "A",
        aliases: ["Public Key"],
        caseSensitive: false,
      }),
      b: makeEntry({
        term: "B",
        aliases: ["Key Encryption"],
        caseSensitive: false,
      }),
    });
    const tree = root(paragraph(text("Public Key Encryption is great")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.type).toBe("html");
    const anchors = (n.value.match(/<a /g) ?? []).length;
    expect(anchors).toBe(1);
    expect(n.value).toContain(">Public Key</a>");
    expect(n.value).toContain(" Encryption is great");
  });

  it("case-insensitive match suppressed by earlier overlapping case-sensitive match", () => {
    const data = makeData({
      cs: makeEntry({
        term: "ABC",
        aliases: ["ABC DEF"],
        caseSensitive: true,
      }),
      ci: makeEntry({
        term: "Def",
        aliases: ["DEF GHI"],
        caseSensitive: false,
      }),
    });
    const tree = root(paragraph(text("ABC DEF GHI")));
    run(data, "all", tree);
    const n = firstChild(tree, 0, 0) as HtmlNode;
    const anchors = (n.value.match(/<a /g) ?? []).length;
    // ABC DEF takes precedence; remaining " GHI" isn't an alias alone
    expect(anchors).toBe(1);
    expect(n.value).toContain(">ABC DEF</a>");
  });
});

describe("remarkAutoTag — empty / edge cases", () => {
  it("empty text node does not crash and stays a text node", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const tree = root(paragraph(text("")));
    run(data, "all", tree);
    const t = firstChild(tree, 0, 0);
    expect(t.type).toBe("text");
    expect((t as TextNode).value).toBe("");
  });

  it("text node with no matches is left untouched", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const tree = root(paragraph(text("nothing to see here")));
    run(data, "all", tree);
    const t = firstChild(tree, 0, 0);
    expect(t.type).toBe("text");
    expect((t as TextNode).value).toBe("nothing to see here");
  });

  it("custom routePrefix is used in anchor href", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const tree = root(paragraph(text("I use TLS daily")));
    run(data, "all", tree, "/terms");
    const n = firstChild(tree, 0, 0) as HtmlNode;
    expect(n.value).toContain('href="/terms#tls"');
  });

  it("mutating text to html in-place preserves the parent's children array identity", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const para = paragraph(text("I use TLS daily"));
    const tree = root(para);
    const beforeChildren = (para as { children: AnyNode[] }).children;
    run(data, "all", tree);
    const afterChildren = (para as { children: AnyNode[] }).children;
    // same array reference — autotag must mutate nodes in-place, not splice
    expect(afterChildren).toBe(beforeChildren);
    expect(afterChildren.length).toBe(1);
    expect(afterChildren[0].type).toBe("html");
  });
});

describe("remarkAutoTag — page opt-out (frontmatter)", () => {
  it("page with frontmatter glossary: false is left alone", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const para = paragraph(text("I use TLS daily"));
    const tree = root(para);
    const file = { data: { astro: { frontmatter: { glossary: false } } } };
    const transformer = remarkAutoTag({
      mode: "all",
      routePrefix: "/glossary",
      data,
    });
    transformer(tree, file);
    expect((para as { children: AnyNode[] }).children[0].type).toBe("text");
  });

  it("page with frontmatter glossary: true (or absent) is tagged normally", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const para = paragraph(text("I use TLS daily"));
    const tree = root(para);
    const file = { data: { astro: { frontmatter: { glossary: true } } } };
    const transformer = remarkAutoTag({
      mode: "all",
      routePrefix: "/glossary",
      data,
    });
    transformer(tree, file);
    expect((para as { children: AnyNode[] }).children[0].type).toBe("html");
  });

  it("opt-out is robust to missing file.data structure", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const para = paragraph(text("I use TLS daily"));
    const tree = root(para);
    const transformer = remarkAutoTag({
      mode: "all",
      routePrefix: "/glossary",
      data,
    });
    transformer(tree, undefined);
    expect((para as { children: AnyNode[] }).children[0].type).toBe("html");
  });
});

describe("remarkAutoTag — inline opt-out markers", () => {
  function html(value: string) {
    return { type: "html", value };
  }

  it("text between <!-- glossary-off --> and <!-- glossary-on --> is not tagged", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const tree = root(
      paragraph(text("Before TLS")),
      html("<!-- glossary-off -->"),
      paragraph(text("Inside TLS quiet")),
      html("<!-- glossary-on -->"),
      paragraph(text("After TLS")),
    );
    run(data, "all", tree);
    const paras = (tree as { children: AnyNode[] }).children.filter(
      (n) => n.type === "paragraph",
    );
    // Before & After: tagged. Inside: untouched.
    expect((paras[0] as { children: AnyNode[] }).children[0].type).toBe("html");
    expect((paras[1] as { children: AnyNode[] }).children[0].type).toBe("text");
    expect((paras[2] as { children: AnyNode[] }).children[0].type).toBe("html");
  });

  it("marker recognition tolerates surrounding whitespace", () => {
    const data = makeData({
      tls: makeEntry({ term: "TLS", aliases: ["TLS"], caseSensitive: false }),
    });
    const tree = root(
      html("  <!--  glossary-off  -->  "),
      paragraph(text("Quiet TLS")),
    );
    run(data, "all", tree);
    const para = (tree as { children: AnyNode[] }).children[1];
    expect((para as { children: AnyNode[] }).children[0].type).toBe("text");
  });
});
