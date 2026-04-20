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
// node, we walk matches left-to-right and wrap them in tagged anchors. In
// "first" mode, each slug is emitted at most once per page (state lives on
// a file-level tracker the caller supplies — see the astro plugin hook).

interface MatcherEntry {
  slug: string;
  variants: string[];
  caseSensitive: boolean;
}

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

  // `\b` in JS regex is ASCII-only; acceptable for our English-only corpus.
  const csRe = cs.length ? new RegExp(`\\b(?:${cs.join("|")})\\b`, "g") : null;
  const ciRe = ci.length ? new RegExp(`\\b(?:${ci.join("|")})\\b`, "gi") : null;
  return { caseSensitiveRe: csRe, caseInsensitiveRe: ciRe, aliasToSlug, aliasToSlugCi };
}

export interface AutoTagContext {
  matcher: ReturnType<typeof buildMatcher>;
  mode: AutoTagMode;
  routePrefix: string;
  /** Slugs tagged earlier in the same document (used for `mode: "first"`). */
  tagged: Set<string>;
}

/** Remark plugin that auto-tags alias matches in text nodes, respecting
 *  code/heading/link context and the first-per-page rule. */
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
    visit(
      tree as Parameters<typeof visit>[0],
      (node: unknown) => {
        const n = node as { type: string };
        // Skip entire subtrees where tagging is unwanted.
        if (
          n.type === "code" ||
          n.type === "inlineCode" ||
          n.type === "heading" ||
          n.type === "link" ||
          n.type === "linkReference"
        ) {
          return SKIP;
        }
        if (n.type !== "text") return;
        tagTextNode(n as TextNode, ctx);
      },
    );
  };
}

interface TextNode {
  type: "text";
  value: string;
}

function tagTextNode(node: TextNode, ctx: AutoTagContext): void {
  const value = node.value;
  if (!value) return;

  const replacements = findMatches(value, ctx);
  if (replacements.length === 0) return;

  // Rebuild this text node as a sequence of text + link children on its
  // parent. Since unist-util-visit doesn't expose the parent directly, we
  // mutate in place by turning the text node into a paragraph-ish sequence:
  // unfortunately mdast `text` has no children, so we approximate by using
  // HTML passthrough (rehype node type `html`) for the anchor. That keeps
  // the AST valid and renders correctly through the Starlight pipeline.
  const parts: Array<
    | { type: "text"; value: string }
    | { type: "html"; value: string }
  > = [];
  let cursor = 0;
  for (const m of replacements) {
    if (m.start > cursor) {
      parts.push({ type: "text", value: value.slice(cursor, m.start) });
    }
    const displayed = value.slice(m.start, m.end);
    parts.push({
      type: "html",
      value:
        `<a href="${ctx.routePrefix}#${escapeHtml(m.slug)}" ` +
        `data-glossary-term="${escapeHtml(m.slug)}" ` +
        `class="sl-glossary-term sl-glossary-term--auto">${escapeHtml(displayed)}</a>`,
    });
    cursor = m.end;
  }
  if (cursor < value.length) {
    parts.push({ type: "text", value: value.slice(cursor) });
  }

  // Replace node contents by mutating to the first part and splicing the
  // rest in via a tiny hack: use a special `children` array on the node,
  // detected by a parent-aware pass below. The simpler path is replacing
  // `node.value` with a single HTML chunk that preserves text too.
  const combined = parts
    .map((p) => (p.type === "text" ? escapeHtml(p.value) : p.value))
    .join("");
  (node as unknown as { type: string; value: string }).type = "html";
  (node as unknown as { type: string; value: string }).value = combined;
}

interface Match {
  start: number;
  end: number;
  slug: string;
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
      ctx.tagged.add(slug);
    }
  }
  if (caseInsensitiveRe) {
    caseInsensitiveRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = caseInsensitiveRe.exec(text)) !== null) {
      const slug = aliasToSlugCi.get(m[0].toLowerCase());
      if (!slug) continue;
      // Skip if the case-sensitive pass already matched this span.
      if (
        matches.some(
          (x) => x.start < m!.index + m![0].length && x.end > m!.index,
        )
      ) {
        continue;
      }
      if (ctx.mode === "first" && ctx.tagged.has(slug)) continue;
      matches.push({ start: m.index, end: m.index + m[0].length, slug });
      ctx.tagged.add(slug);
    }
  }

  matches.sort((a, b) => a.start - b.start);
  // Drop overlaps (longer-match-wins is implicit from the alias sort).
  const out: Match[] = [];
  let last = -1;
  for (const m of matches) {
    if (m.start >= last) {
      out.push(m);
      last = m.end;
    }
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
