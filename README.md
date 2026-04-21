# starlight-glossary

A [Starlight](https://starlight.astro.build/) plugin that adds an interactive glossary with hover tooltips to your Astro documentation site. Writes one glossary reference in any doc and the plugin does the rest: auto-fetches a Wikipedia summary, auto-tags further mentions of the same term, renders a `/glossary` index page, and shows a rich popover on hover or tap.

Designed to be zero-ceremony: no per-term markdown files, no CLI commands, no content collection to configure. A single `glossary.json` file lives at your project root and the plugin keeps it (and a sibling `glossary-cache.json`) up to date as you work — whether you're running `astro dev` or `astro build`.

## What it does

- **Tag terms in docs** — write `[HPKE](glossary:hpke)` (or `[HPKE](glossary)` for short — the link text is reused as the slug)
- **Auto-tag plain text** — on every build, scans all docs for known terms + aliases and wraps the first occurrence on each page in a tooltip link
- **Auto-discover missing terms** — unknown glossary references trigger a Wikipedia fetch at the end of the build, persisted into `glossary-cache.json`
- **Auto-promote aliases** — any new link label on a known slug is added to that entry's alias list
- **Hover tooltip** — fetches a compact JSON once, renders Wikipedia summaries (or custom definitions) via the native HTML Popover API — no framework, ~200 lines of vanilla JS
- **Read-state tracking** — `:visited` CSS + localStorage (hover ≥1.5s counts as read) styles terms you've seen in a muted colour
- **`/glossary` index page** — auto-generated, alphabetical, with Wikipedia links and grouped sub-entries
- **Build-time lint** — logs suggestions for repeated untagged acronyms and proper nouns

## Installation

```sh
pnpm add starlight-glossary
# or: npm install starlight-glossary / yarn add starlight-glossary
```

## Setup

### 1. Register the plugin

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightGlossary from "starlight-glossary";

export default defineConfig({
  integrations: [
    starlight({
      title: "My Docs",
      plugins: [starlightGlossary()],
    }),
  ],
});
```

The plugin auto-registers its tooltip stylesheet — no changes to `customCss` needed.

### 2. Create `glossary.json` at your project root

```json
{
  "version": 1,
  "terms": {
    "tls": {
      "term": "TLS",
      "aliases": ["TLS", "SSL", "Transport Layer Security"],
      "wikipedia": "Transport_Layer_Security",
      "caseSensitive": true,
      "definition": null,
      "groupWith": null
    }
  }
}
```

If the file doesn't exist, the plugin creates an empty one on first build and grows it as you add references in docs.

### 3. Reference terms in any doc

Three equivalent forms:

```md
Most protocols build on [TLS](glossary:tls) for transport security.

Or use the shorthand when the label matches the slug:
[TLS](glossary:) and [TLS](glossary) both work.
```

Plain text mentions of `"TLS"`, `"SSL"`, or `"Transport Layer Security"` get auto-tagged on first occurrence per page.

## Entry schema

Each entry in `glossary.json` under `terms[slug]`:

| Field | Type | Description |
|---|---|---|
| `term` | string | Display name shown in the tooltip and on the `/glossary` page |
| `aliases` | string[] | Strings that auto-tag to this entry. Includes `term` by convention. Additions from link labels are merged automatically. |
| `wikipedia` | string \| null | Wikipedia article slug (e.g. `"Transport_Layer_Security"` or `"Transport_Layer_Security#TLS_1.3"` with a fragment). `null` disables the Wikipedia link. |
| `caseSensitive` | boolean | If `true`, auto-tag only matches exact case (good for acronyms: `TLS` not `tls`). |
| `definition` | string \| null | Custom tooltip body that overrides the cached Wikipedia extract. |
| `groupWith` | string \| null | Slug of another entry. When set, this entry renders as a nested sub-section under the parent on `/glossary` (useful for variants like `tls-1-3` grouped under `tls`). |
| `mergedInto` | string \| null \| absent | Set automatically by the reconcile pass when this entry is folded into a canonical entry. Old slugs still forward at render time. Hand-editing not usually necessary. |
| `aliasFragments` | object | Map of alias-text → Wikipedia fragment. Populated automatically when docs reference the entry with `glossary:Article#Section` syntax. Subsequent mentions of that label get the fragment-aware Wikipedia link. |
| `wikipediaRedirectAcknowledged` | string \| null | Acknowledge that you intentionally point this entry at a Wikipedia article whose canonical title differs from `term`. Set to the cached Wikipedia title to silence the "term differs from Wikipedia" warning until that title changes again. |

### Sub-sections and fragments

To link a variant to a specific Wikipedia section, use a fragment in the `wikipedia` slug:

```json
{
  "tls-1-3": {
    "term": "TLS 1.3",
    "aliases": ["TLS 1.3", "TLSv1.3"],
    "wikipedia": "Transport_Layer_Security#TLS_1.3",
    "groupWith": "tls"
  }
}
```

The `/glossary` page shows TLS 1.3 as a sub-entry under TLS; the tooltip's "Read on Wikipedia" footer link points at the right section.

## Configuration

```js
starlightGlossary({
  // URL prefix for the generated routes. Default: "/glossary".
  routePrefix: "/glossary",

  // Path (relative to project root) to the committed index. Default: "glossary.json".
  indexFile: "glossary.json",

  // Path (relative to project root) to the Wikipedia cache. Default: "glossary-cache.json".
  cacheFile: "glossary-cache.json",

  // Base URL used to build Wikipedia links. Default: English Wikipedia.
  wikipediaBase: "https://en.wikipedia.org/wiki/",

  autoTag: {
    // "first" — tag first occurrence per page (default)
    // "all"   — tag every occurrence
    // "off"   — only tag explicit [x](glossary:y) links
    mode: "first",
  },

  discovery: {
    // When true (default), unknown glossary references trigger a Wikipedia
    // lookup at end-of-build and get persisted into glossary.json + cache.
    enabled: true,
  },

  wikipedia: {
    // Set to false for offline / air-gapped builds. No network calls;
    // tooltips render whatever is already in glossary-cache.json.
    enabled: true,
    // When true, any Wikipedia fetch error fails the build. Recommended
    // for CI so you find out about connectivity issues early.
    strict: false,
    // Per-request timeout in ms. Hitting the timeout retries with backoff.
    timeoutMs: 10_000,
  },

  reconcile: {
    // Set to false to disable Wikipedia-redirect-based merge/rename
    // entirely (cache fill still runs).
    enabled: true,
    // Set to true to *preview* what reconcile would do without
    // modifying glossary.json, glossary-cache.json, or any doc files.
    // The build log shows "[dry-run] would merge / would adopt …" so
    // you can audit before opting in.
    //
    // Default: false, EXCEPT on the very first build (when there's no
    // glossary-cache.json yet), where dryRun is forced to true so a
    // fresh install never silently rewrites doc files. Remove this
    // option after that first build to resume auto-application.
    dryRun: false,
    // When false, merges still happen in glossary.json (the source
    // becomes a mergedInto stub) but [label](glossary:old-slug)
    // references in src/content/docs/ are NOT rewritten. Doc links
    // continue to resolve through the stub at render time.
    rewriteDocRefs: true,
    // CI hook: throw if reconcile reported any SKIPs (Wikipedia
    // redirects with substantial title changes not auto-adopted and
    // not acknowledged via wikipediaRedirectAcknowledged). Forces
    // explicit review of every divergence.
    failOnSkips: false,
  },

  lint: {
    // When true (default), the build logs untagged ALL-CAPS acronyms +
    // repeated proper nouns that may be worth adding to the glossary.
    // Full report written to .astro/glossary-lint.md.
    enabled: true,
    // Minimum occurrences across all docs before a term is flagged.
    minOccurrences: 3,
    // Silence false-positive findings. Accepts strings (exact match,
    // case-insensitive) or RegExp patterns. Useful for generic phrases
    // that happen to pattern-match but aren't glossary candidates.
    ignore: [
      "Total Message",       // generic prose, not a named concept
      "Associated Data",     // already covered by the AAD entry
      /^v\d+$/,              // version tokens like "V1", "V2"
    ],
    // Feed every lint finding into the Wikipedia discovery pipeline.
    // Unambiguous hits auto-add to glossary.json + cache; disambiguation
    // pages, 404s, and fetch errors fall through to the lint report
    // with an explanation. Closes the loop: write prose → build →
    // glossary grows itself. Review each auto-add before committing
    // — the build log prints the matched Wikipedia title + one-liner +
    // full URL for every success.
    autoDiscover: false,
    // CI hook: throw if any findings remain at end of build. Use this
    // to enforce "no new untagged acronyms/proper-nouns slip through
    // without being added to glossary.json."
    failOnFindings: false,
  },
});
```

### How auto-tagging picks matches

When several glossary aliases could match overlapping text, the rules are:

1. **Earliest start wins.** Given `"IP"` and `"IP routing"` both starting at position 0 of `"IP routing is fast"`, both are candidates. Position is the first tiebreaker.
2. **At a tie, longer wins.** When two matches start at the same position (very common with nested aliases like `IP` vs `IP routing`), the longer one is taken. This holds across case-sensitivity boundaries — a longer case-insensitive alias beats a shorter case-sensitive one.
3. **Exact-case wins ties.** When two matches have the same start *and* the same length but different slugs, the case-sensitive entry wins (rare but well-defined for predictability).
4. **Word boundaries are strict.** `\bIP\b` does not match inside `IPS` or `HTTPS`. `\bIP routing\b` matches only when both the leading and trailing edges are word boundaries.

So if you have both `IP` (acronym) and `IP routing` (specific concept) in your glossary:
- "the **IP routing** layer" — tags `IP routing`
- "the **IP** address" — tags `IP`
- "VoIP networks" — tags neither (no word boundary)

If you only have `IP`, then `"IP routing"` tags only `IP` and ` routing` stays plain text.

### Per-page autotag opt-out

Disable auto-tagging on a single page via frontmatter:

```md
---
title: Style Guide
glossary: false
---
```

Or toggle inline within a page using HTML comments:

```md
This sentence will tag known terms like TLS.

<!-- glossary-off -->
This sentence will NOT have its terms tagged.
<!-- glossary-on -->

This sentence resumes tagging.
```

Useful for code-style guides, FAQs that mention terms in a meta way, or any prose where the tooltip would be more distracting than helpful.

## How the build works

Every page render runs the same pipeline:

1. **Load** `glossary.json` + `glossary-cache.json` at startup (missing cache is tolerated — it gets populated below).
2. **Remark pass A**: rewrite every `[x](glossary:...)` link to a tagged `<a class="sl-glossary-term">`. Record the reference (slug + label) for the finalize step.
3. **Remark pass B (auto-tag)**: walk text nodes, match against the alias index, wrap first occurrences in the same tagged-anchor form. Skips code blocks, headings, existing links, and MDX JSX elements.
4. **Lint pass**: count untagged ALL-CAPS acronyms (2–6 letters, starting with a letter) and repeated capitalised proper nouns (2–4 words).

The finalize step — alias promotion, Wikipedia discovery, atomic writes, lint report — runs at two different triggers:

- **`astro build`** — once at `astro:build:done`, after every page has been rendered.
- **`astro dev`** — debounced (~2s) and scheduled by the remark pass when it sees a new slug or alias label since the last run. Cheap when nothing changed; also runs one final pass on dev-server shutdown.

No manual CLI steps. Editing `glossary.json` by hand works fine — the plugin respects everything you set and only extends. The file is validated at startup so typos surface as a clear error rather than a cryptic runtime crash.

## Source-level transform (for `.md` endpoints, `llms.txt`, etc.)

If your site exposes raw markdown somewhere (a `.md` API endpoint, an `llms.txt` generator), you can resolve `[x](glossary:y)` references at the source level — outside the HTML pipeline:

```ts
import {
  loadGlossaryMap,
  resolveGlossaryLinks,
} from "starlight-glossary/transform";

const glossary = await loadGlossaryMap();
const transformed = resolveGlossaryLinks(entry.body, glossary, {
  siteOrigin: "https://docs.example.com",
});
// [TLS](glossary:tls) → [TLS](https://en.wikipedia.org/wiki/Transport_Layer_Security)
```

When the glossary entry has a `wikipedia` value (with or without a fragment), the resolved URL points at Wikipedia. Otherwise it falls back to the on-site `/glossary#slug` anchor.

## Styling hooks

The plugin ships these CSS classes; override them in your own stylesheet if you want different appearance:

| Class | Meaning |
|---|---|
| `.sl-glossary-term` | Any glossary-tagged link (explicit or auto) |
| `.sl-glossary-term--auto` | Added to auto-tagged instances specifically |
| `.sl-glossary-term--pending` | Reference to a slug that isn't in the index yet (discovery may fill this in) |
| `.sl-glossary-term:visited` | Muted — user has clicked through to the glossary page |
| `.sl-glossary-term[data-glossary-read]` | Muted — user has hovered ≥1.5s (localStorage) |
| `.sl-glossary-popover` | The tooltip element itself |

## LLM-assisted glossary curation

When lint flags terms that aren't in `glossary.json` and auto-discover fails to resolve them cleanly (disambiguation pages, 404s, project-specific phrases), the plugin emits `.astro/glossary-lint-context.json` — a structured context dump ready to feed to any LLM (Claude, GPT, local model, etc.) for disambiguation help.

### The workflow

```sh
# 1. Build your site. Plugin emits the context dump alongside the human report.
pnpm build

# 2. Feed context to an LLM. It proposes a resolutions file describing
#    how to resolve each finding (add alias, create entry, ignore, skip).
claude "resolve the findings in .astro/glossary-lint-context.json. \
  Use the existing corpus to decide whether each term is an alias for \
  an existing entry, a new entry with a specific Wikipedia article, a \
  stub with a custom definition, or noise to add to lint.ignore. \
  Output resolutions.json matching the shape described in the file's \
  description field." > resolutions.json

# 3. Preview what apply would do (always safe — writes nothing).
pnpm exec starlight-glossary-apply resolutions.json --dry-run

# 4. Apply for real. glossary.json gets mutated atomically.
pnpm exec starlight-glossary-apply resolutions.json

# 5. Next build picks up the new entries + aliases. Review the diff and commit.
git diff glossary.json
pnpm build
```

### Context dump shape (`.astro/glossary-lint-context.json`)

The file contains:

- **`corpus`** — a summary of every existing glossary entry (slug, term, aliases, relations). The LLM reads this to decide whether a finding is probably an alias for something existing.
- **`findings`** — one entry per unresolved lint candidate, with:
  - `term`, `kind` (`acronym` / `proper-noun`), `occurrences`
  - `proposedSlug` (kebab-case of the term — the LLM can override)
  - `contexts` — up to 5 sample occurrences with file path + ~240-char excerpt centred on the match, so the LLM can ground its decision in domain context
  - `wikipediaOutcome` (when auto-discover attempted this term): what Wikipedia returned (disambiguation / missing / fetch error) and what query was tried

### Resolutions file shape

The LLM's output. Each entry chooses **one** action:

| Action | What it does | Required fields |
|---|---|---|
| `add_alias` | Push `alias` onto the `aliases` array of an existing entry | `targetSlug`, `alias` |
| `create` | Insert a new glossary entry at `slug` using `entry` (defaults filled in) | `slug`, `entry` |
| `ignore` | Print a reminder to add the term to `lint.ignore` in your config — does **not** mutate `glossary.json` or your config file | `note` (optional) |
| `skip` | No-op; finding stays in future lint runs | — |

Example:

```json
{
  "version": 1,
  "resolutions": [
    { "term": "TLS", "action": "add_alias",
      "targetSlug": "transport-layer-security", "alias": "TLS" },
    { "term": "OSI", "action": "create", "slug": "osi-model",
      "entry": {
        "term": "OSI model",
        "aliases": ["OSI", "OSI model"],
        "wikipedia": "OSI_model",
        "caseSensitive": false
      } },
    { "term": "End Reliability", "action": "ignore",
      "note": "project-internal, not a glossary term" },
    { "term": "Counter Mode", "action": "skip" }
  ]
}
```

### Why not embed an LLM in the plugin?

Because it would force every consumer of the plugin to pay (money, latency, privacy of docs content sent to a vendor, and lock-in to one LLM). The context-dump + apply-command split keeps the plugin **deterministic, offline-friendly, and LLM-agnostic**. Bring your own intelligence — the plugin just packages the data and applies the decision.

## Working with reconcile (Wikipedia redirects)

When the cached Wikipedia title for an entry differs from its `term`, the reconcile pass tries to resolve the divergence safely:

- **RENAME** — adopts the canonical Wikipedia title when the change is case-only or one is a prefix of the other (e.g. `"public key"` → `"Public-key cryptography"`). Old term is preserved as an alias.
- **MERGE** — folds this entry into another existing entry that already owns the canonical Wikipedia article. The source becomes a `mergedInto` stub; the target absorbs aliases. References in `src/content/docs/` are auto-rewritten to the canonical slug (disable via `reconcile.rewriteDocRefs: false`).
- **SKIP** — when the title change is substantial (e.g. `ChaCha20` → `Salsa20`) the entry is left alone and a warning is logged. To silence the warning permanently, add `wikipediaRedirectAcknowledged: "<the cached title>"` to the entry. The warning resumes if Wikipedia later changes the canonical title to something else.

If you want to *preview* what reconcile would do without applying any changes, set `reconcile: { dryRun: true }` in your plugin options. The build log shows `[dry-run] would merge / would adopt …` so you can audit before opting in.

## Sharing a glossary across multiple sites

Several docs sites in the same org? Put `glossary.json` and `glossary-cache.json` in a shared location and point every site at them:

```js
starlightGlossary({
  indexFile: "../shared/glossary.json",         // relative to project root
  cacheFile: "../shared/glossary-cache.json",
  // or absolute:
  // indexFile: "/Users/me/code/shared-glossary/glossary.json",
});
```

Each site still gets its own `/glossary` index page and `/glossary/data.json` — they just share the underlying term list and Wikipedia cache. Discovery and reconcile run on whichever build first sees an unknown reference; subsequent sites pick up the updated file automatically. Commit the shared files to git like any other source.

For CI, make sure the shared path is writable by the build. Atomic writes mean concurrent builds don't corrupt each other, but they do race (last-writer-wins for fresh discoveries). If that bothers you, fix `reconcile.dryRun: true` on every site except one "canonical" site.

## Hand-editing `glossary.json`

Hand-editing is fully supported. The file is validated at startup with path-annotated error messages — a typo like `"caseSensitive": "yes"` produces:

```
glossary.json failed validation (1 problem):
  · terms["tls"].caseSensitive: expected boolean
```

So you find out immediately, not later from a cryptic runtime crash.

## Why not per-term `.md` files?

Earlier versions of this plugin used a content collection (`src/content/glossary/*.md`). A single `glossary.json` turned out to be a better fit:

- Adding a term from Wikipedia is a single append, not a file creation.
- Diffs at term level stay git-friendly without 200-file sprawl.
- The plugin can write back new aliases and freshly-discovered entries atomically.
- No `content.config.ts` boilerplate for consumers.

## Accessibility

- Term links are standard `<a>` elements — reachable via keyboard, screen-reader-announced with their visible label.
- On focus (keyboard) the popover opens automatically; on blur it closes after a short delay.
- The popover is declared as `role="dialog"` with `aria-modal="false"` and `aria-labelledby` pointing at the term heading, so screen readers announce "`<term>` dialog" when focus or hover triggers it.
- Term links carry `aria-haspopup="dialog"`, `aria-controls`, and `aria-expanded` so assistive tech can signal that expandable content is available.
- Native HTML Popover API handles inert/Escape/focus-return automatically when the platform supports it.

**Known keyboard-only limitation:** the popover body (close button, Wikipedia link) isn't auto-focused on open, so keyboard users currently can't easily tab into the popover's own controls. You can still reach the underlying glossary page via the term's own `href` (`/glossary#slug`), and close via ESC. A future release will add opt-in focus management for fully keyboard-operable tooltips.

## Development

```sh
git clone https://github.com/Wave-RF/starlight-glossary.git
cd starlight-glossary
pnpm install
pnpm typecheck
pnpm test
```

The project ships uncompiled TypeScript (consumed by Astro/Vite directly). Test suite uses [vitest](https://vitest.dev/); CI runs typecheck + tests on every push and pull request.

## License

MIT © [Wave RF](https://wave-rf.com)
