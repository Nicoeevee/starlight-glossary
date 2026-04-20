import { visit, SKIP } from "unist-util-visit";
import type { GlossaryData } from "./data.js";

export type AutoTagMode = "off" | "first" | "all";

export interface AutoTagOptions {
  mode: AutoTagMode;
  routePrefix: string;
  data: GlossaryData;
}

// Build two regex tables once:
//   - caseInsensitiveRe: alternation of all lowercased aliases for
//     entries flagged caseSensitive=false.
//   - caseSensitiveRe: alternation of all aliases for caseSensitive=true
//     entries, matched exactly.
//
// Match on word boundaries so "HTTP" doesn't grab "HTTPS". Inside each text
// node, we walk matches left-to-right and split the node on the parent into
// a sequence of `text` + `link` children. This works for both .md and .mdx
// sources (raw HTML nodes would break the MDX pipeline).

export function buildMatcher(data: GlossaryData): {
  caseSensitiveRe: RegExp | null;
  caseInsensitiveRe: RegExp | null;
  aliasToSlug: Map<string, string>;
  aliasToSlugCi: Map<string, string>;
} {
  const aliasToSlug = new Map<string, string>();
  const aliasToSlugCi = new Map<string, string>();
  const cs: string[] = [];
  const ci: string[] = [];
  for (const entry of Object.values(data.terms)) {
    for (const alias of entry.aliases) {
      if (entry.caseSensitive) {
        aliasToSlug.set(alias, entry.slug);
        cs.push(escapeRegex(alias));
      } else {
        aliasToSlugCi.set(alias.toLowerCase(), entry.slug);
        ci.push(escapeRegex(alias));
      }
    }
  }
  // Sort by length descending so "Hybrid Public Key Encryption" is tried
  // before "HPKE" — the longer match wins inside the regex.
  cs.sort((a, b) => b.length - a.length);
  ci.sort((a, b) => b.length - a.length);

  const csRe = cs.length ? new RegExp(`\\b(?:${cs.join("|")})\\b`, "g") : null;
  const ciRe = ci.length ? new RegExp(`\\b(?:${ci.join("|")})\\b`, "gi") : null;
  return { caseSensitiveRe: csRe, caseInsensitiveRe: ciRe, aliasToSlug, aliasToSlugCi };
}

interface AutoTagContext {
  matcher: ReturnType<typeof buildMatcher>;
  mode: AutoTagMode;
  routePrefix: string;
  tagged: Set<string>;
}

interface TextNode {
  type: "text";
  value: string;
}

interface LinkNode {
  type: "link";
  url: string;
  data: {
    hProperties: Record<string, string>;
  };
  children: TextNode[];
}

type UnistParent = {
  type: string;
  children: (TextNode | LinkNode | { type: string })[];
};

interface Match {
  start: number;
  end: number;
  slug: string;
}

// Allow-list of parent node types where it's safe to tag text. Narrow on
// purpose — MDX trees contain node types we don't understand, and only
// standard markdown inline containers are guaranteed to survive our
// `text`-to-`html` rewrite.
const SAFE_PARENT_TYPES = new Set([
  "paragraph",
  "listItem",
  "emphasis",
  "strong",
  "blockquote",
  "delete",
  "tableCell",
  "footnoteDefinition",
]);

export function remarkAutoTag(opts: AutoTagOptions) {
  return function transformer(tree: unknown) {
    if (opts.mode === "off") return;
    const matcher = buildMatcher(opts.data);
    const ctx: AutoTagContext = {
      matcher,
      mode: opts.mode,
      routePrefix: opts.routePrefix,
      tagged: new Set(),
    };

    // Rewrite each matching text node in-place to an `html` node. This
    // avoids splicing on the parent (which trips up MDX's AST processing)
    // while still producing tagged anchors in the rendered output. HTML
    // nodes are valid in both mdast and the MDX pipeline.
    visit(
      tree as Parameters<typeof visit>[0],
      "text",
      (node, _index, parent) => {
        if (!parent) return;
        const p = parent as unknown as { type: string };
        if (!SAFE_PARENT_TYPES.has(p.type)) return;

        const n = node as unknown as TextNode;
        const text = n.value;
        const matches = findMatches(text, ctx);
        if (matches.length === 0) return;

        // Build HTML string: escape non-match text, wrap matches in <a>.
        const chunks: string[] = [];
        let cursor = 0;
        for (const m of matches) {
          if (m.start > cursor) {
            chunks.push(escapeHtml(text.slice(cursor, m.start)));
          }
          const displayed = text.slice(m.start, m.end);
          chunks.push(
            `<a href="${ctx.routePrefix}#${escapeAttr(m.slug)}" ` +
              `data-glossary-term="${escapeAttr(m.slug)}" ` +
              `class="sl-glossary-term sl-glossary-term--auto">${escapeHtml(displayed)}</a>`,
          );
          cursor = m.end;
        }
        if (cursor < text.length) {
          chunks.push(escapeHtml(text.slice(cursor)));
        }

        // Convert the text node in-place. `html` is a valid mdast node type
        // and the MDX pipeline treats it as raw HTML passthrough.
        const mutable = node as unknown as { type: string; value: string };
        mutable.type = "html";
        mutable.value = chunks.join("");
      },
    );
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function findMatches(text: string, ctx: AutoTagContext): Match[] {
  const matches: Match[] = [];
  const { caseSensitiveRe, caseInsensitiveRe, aliasToSlug, aliasToSlugCi } =
    ctx.matcher;

  if (caseSensitiveRe) {
    caseSensitiveRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = caseSensitiveRe.exec(text)) !== null) {
      const slug = aliasToSlug.get(m[0]);
      if (!slug) continue;
      if (ctx.mode === "first" && ctx.tagged.has(slug)) continue;
      matches.push({ start: m.index, end: m.index + m[0].length, slug });
    }
  }
  if (caseInsensitiveRe) {
    caseInsensitiveRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = caseInsensitiveRe.exec(text)) !== null) {
      const slug = aliasToSlugCi.get(m[0].toLowerCase());
      if (!slug) continue;
      // Skip if a case-sensitive match already covers this span.
      if (
        matches.some(
          (x) => x.start < m!.index + m![0].length && x.end > m!.index,
        )
      ) {
        continue;
      }
      if (ctx.mode === "first" && ctx.tagged.has(slug)) continue;
      matches.push({ start: m.index, end: m.index + m[0].length, slug });
    }
  }

  matches.sort((a, b) => a.start - b.start);
  const out: Match[] = [];
  let last = -1;
  for (const m of matches) {
    if (m.start >= last) {
      out.push(m);
      last = m.end;
      if (ctx.mode === "first") ctx.tagged.add(m.slug);
    }
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
