import { describe, expect, it } from "vitest";
import { createLintCollector, renderLintReport } from "./lint.js";
import { joinGlossary, type GlossaryData } from "./data.js";

function emptyData(): GlossaryData {
  return joinGlossary(
    { version: 1, terms: {} },
    { version: 1, fetchedAt: "", terms: {} },
    { routePrefix: "/glossary", wikipediaBase: "https://en.wikipedia.org/wiki/" },
  );
}

interface TextNode {
  type: "text";
  value: string;
}
interface ParaNode {
  type: "paragraph";
  children: TextNode[];
}
function tree(...paragraphs: ParaNode[]) {
  return { type: "root", children: paragraphs };
}
function p(...texts: string[]): ParaNode {
  return {
    type: "paragraph",
    children: texts.map((value) => ({ type: "text", value })),
  };
}

function runLint(
  texts: string[],
  opts: Partial<Parameters<typeof createLintCollector>[0]> = {},
) {
  const collector = createLintCollector({
    enabled: true,
    minOccurrences: 3,
    data: emptyData(),
    ...opts,
  });
  const transformer = collector.remarkPlugin();
  for (const text of texts) {
    transformer(tree(p(text)));
  }
  return collector.findings();
}

describe("lint: acronym detection", () => {
  it("flags a 3+ occurrence unknown acronym", () => {
    const findings = runLint([
      "We use SSH for remote access.",
      "SSH works over TCP.",
      "The SSH client is nice.",
    ]);
    expect(findings.map((f) => f.term)).toContain("SSH");
  });

  it("does not flag known glossary aliases", () => {
    const collector = createLintCollector({
      enabled: true,
      minOccurrences: 2,
      data: joinGlossary(
        {
          version: 1,
          terms: {
            ssh: {
              term: "SSH",
              aliases: ["SSH"],
              wikipedia: null,
              caseSensitive: true,
              definition: null,
              groupWith: null,
            },
          },
        },
        { version: 1, fetchedAt: "", terms: {} },
        { routePrefix: "/glossary", wikipediaBase: "" },
      ),
    });
    const transformer = collector.remarkPlugin();
    transformer(tree(p("SSH is great"), p("SSH rules"), p("SSH everywhere")));
    const findings = collector.findings();
    expect(findings.map((f) => f.term)).not.toContain("SSH");
  });

  it("does not flag common English caps words (NOT, OK, YES, ETC…)", () => {
    const findings = runLint([
      "This is NOT expected.",
      "NOT again!",
      "Oh NOT really.",
      "OK, OK, OK.",
    ]);
    expect(findings.map((f) => f.term)).not.toContain("NOT");
    expect(findings.map((f) => f.term)).not.toContain("OK");
  });

  it("baseline suppression covers US, UK, EU", () => {
    const findings = runLint([
      "US deployment",
      "US region",
      "US again",
      "UK here",
      "UK there",
      "UK more",
      "EU zone",
      "EU site",
      "EU region",
    ]);
    for (const f of findings) expect(["US", "UK", "EU"]).not.toContain(f.term);
  });

  it("respects minOccurrences", () => {
    const findings = runLint(["XYZ once", "XYZ twice"], {
      minOccurrences: 3,
    });
    expect(findings.map((f) => f.term)).not.toContain("XYZ");
  });
});

describe("lint.ignore (string matching)", () => {
  it("suppresses an explicit string (case-insensitive)", () => {
    const findings = runLint(
      ["QR code 1", "QR code 2", "QR code 3"],
      { ignore: ["qr"] },
    );
    expect(findings.map((f) => f.term)).not.toContain("QR");
  });

  it("does not over-suppress: exact-only matching, no substring", () => {
    const findings = runLint(
      ["ABC one", "ABC two", "ABC three", "ABCD x", "ABCD y", "ABCD z"],
      { ignore: ["ABC"] },
    );
    expect(findings.map((f) => f.term)).not.toContain("ABC");
    expect(findings.map((f) => f.term)).toContain("ABCD");
  });
});

describe("lint.ignore (regex)", () => {
  it("suppresses every match of a pattern", () => {
    const findings = runLint(
      ["FOO one", "FOO two", "FOO three", "BAR x", "BAR y", "BAR z"],
      { ignore: [/^(FOO|BAR)$/] },
    );
    const terms = findings.map((f) => f.term);
    expect(terms).not.toContain("FOO");
    expect(terms).not.toContain("BAR");
  });

  it("does not touch terms that don't match the pattern", () => {
    const findings = runLint(
      ["ZZZ x", "ZZZ y", "ZZZ z"],
      { ignore: [/^FOO$/] },
    );
    expect(findings.map((f) => f.term)).toContain("ZZZ");
  });
});

describe("lint: proper noun detection", () => {
  it("flags capitalized two-word phrases repeated", () => {
    const findings = runLint([
      "Wave Clip is a concept.",
      "The Wave Clip connects them.",
      "Each Wave Clip identifies.",
    ]);
    expect(findings.map((f) => f.term)).toContain("Wave Clip");
  });

  it("strips leading stop-words (The/Each/A/This/…) so variants count as one term", () => {
    // Without the strip, these 3 sentences produce 3 separate 1-count
    // proper nouns ("Wave Clip", "The Wave Clip", "Each Wave Clip") and
    // none reaches minOccurrences. With the strip, all 3 are "Wave Clip".
    const findings = runLint([
      "The Wave Clip is here.",
      "This Wave Clip matters.",
      "Each Wave Clip identifies.",
    ]);
    const waveClip = findings.find((f) => f.term === "Wave Clip");
    expect(waveClip?.occurrences).toBe(3);
  });

  it("drops single-word matches after stripping leading stop-words", () => {
    // "The Wikipedia" → "Wikipedia" (single word) → ignored; too noisy.
    const findings = runLint([
      "The Wikipedia",
      "The Wikipedia again",
      "The Wikipedia thrice",
    ]);
    expect(findings.map((f) => f.term)).not.toContain("Wikipedia");
  });

  it("lint.ignore suppresses proper nouns too", () => {
    const findings = runLint(
      [
        "Total Message is vague.",
        "The Total Message counts.",
        "A Total Message sums.",
      ],
      { ignore: ["Total Message"] },
    );
    expect(findings.map((f) => f.term)).not.toContain("Total Message");
  });
});

describe("renderLintReport", () => {
  it("produces a nice table when there are findings", () => {
    const report = renderLintReport([
      { term: "FOO", occurrences: 5, kind: "acronym", sample: "sample text" },
      {
        term: "Bar Baz",
        occurrences: 3,
        kind: "proper-noun",
        sample: "…",
      },
    ]);
    expect(report).toContain("`FOO`");
    expect(report).toContain("`Bar Baz`");
    expect(report).toContain("| Term |");
  });

  it("produces a friendly no-findings message", () => {
    const report = renderLintReport([]);
    expect(report).toContain("No suggestions");
  });
});
