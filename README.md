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

  lint: {
    // When true (default), the build logs untagged ALL-CAPS acronyms +
    // repeated proper nouns that may be worth adding to the glossary.
    // Full report written to .astro/glossary-lint.md.
    enabled: true,
    // Minimum occurrences across all docs before a term is flagged.
    minOccurrences: 3,
  },
});
```

## How the build works

Every page render runs the same pipeline:

1. **Load** `glossary.json` + `glossary-cache.json` at startup (missing cache is tolerated — it gets populated below).
2. **Remark pass A**: rewrite every `[x](glossary:...)` link to a tagged `<a class="sl-glossary-term">`. Record the reference (slug + label) for the finalize step.
3. **Remark pass B (auto-tag)**: walk text nodes, match against the alias index, wrap first occurrences in the same tagged-anchor form. Skips code blocks, headings, existing links, and MDX JSX elements.
4. **Lint pass**: count untagged ALL-CAPS acronyms (2–6 letters, starting with a letter) and repeated capitalised proper nouns (2–4 words).

The finalize step — alias promotion, Wikipedia discovery, atomic writes, lint report — runs at two different triggers:

- **`astro build`** — once at `astro:build:done`, after every page has been rendered.
- **`astro dev`** — on a 5-second poll while the dev server is running. Only actually does work if new references have been seen since the last run, so it's cheap. Also runs one final pass on shutdown.

No manual CLI steps. Editing `glossary.json` by hand works fine — the plugin respects everything you set and only extends.

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

## Why not per-term `.md` files?

Earlier versions of this plugin used a content collection (`src/content/glossary/*.md`). A single `glossary.json` turned out to be a better fit:

- Adding a term from Wikipedia is a single append, not a file creation.
- Diffs at term level stay git-friendly without 200-file sprawl.
- The plugin can write back new aliases and freshly-discovered entries atomically.
- No `content.config.ts` boilerplate for consumers.

## License

MIT © [Wave RF](https://wave-rf.com)
