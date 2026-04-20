# starlight-glossary

A [Starlight](https://starlight.astro.build/) plugin that adds an interactive glossary with hover tooltips to your Astro documentation site.

Authors write `[term](glossary:slug)` inline in any doc; readers hover (or tap on mobile) to see a rich popover with the definition, and clicking navigates to a full `/glossary` page. Glossary entries live in a dedicated content collection — one markdown file per term.

## Features

- `/glossary` index page with every term, generated automatically
- Client-side hover/tap popover with ESC-to-close and keyboard navigation, powered by the native HTML Popover API
- Works without JavaScript — the link still navigates to the glossary page anchor
- Optional `wikipedia` field in each entry adds a "Wikipedia" link to the popover and the index page
- `aliases` field for alternate names
- Exports a **source-level transform** (`resolveGlossaryLinks`) so you can resolve `glossary:slug` links in raw markdown output (e.g. `.md` API endpoints, `llms.txt`) without going through the HTML pipeline

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

The plugin automatically registers its tooltip stylesheet — no changes to `customCss` needed.

### 2. Declare the content collection

```ts
// src/content.config.ts
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { glossarySchema } from "starlight-glossary/schema";

export const collections = {
  glossary: defineCollection({
    loader: glob({ pattern: "**/*.md", base: "./src/content/glossary" }),
    schema: glossarySchema,
  }),
};
```

### 3. Write glossary entries

Each file in `src/content/glossary/` becomes one term. The filename (without `.md`) is the slug used in link protocols — `src/content/glossary/tls.md` is linked as `[TLS](glossary:tls)`.

```md
---
term: "Transport Layer Security"
aliases: ["TLS", "SSL"]
wikipedia: "Transport_Layer_Security"
---

A cryptographic protocol that provides end-to-end security for data sent
between applications over the internet, commonly used for HTTPS.
```

- `term` — display name shown in the popover and on the `/glossary` page
- `aliases` _(optional)_ — alternate names listed on the index page
- `wikipedia` _(optional)_ — Wikipedia article slug (e.g. `Ansible_(software)`); when set, the popover shows a "Wikipedia" link

### 4. Link to terms from any page

In any `.md`/`.mdx` page:

```md
WaveNet packets are secured with [HPKE](glossary:hpke) and signed with
[Ed25519](glossary:ed25519) before transmission.
```

On build, the `glossary:` protocol is rewritten to `/glossary#slug` with `data-glossary-term` attributes. At runtime, the tooltip client upgrades these links with hover/tap popovers.

## Configuration

```js
starlightGlossary({
  collection: "glossary",     // content collection name (default: "glossary")
  routePrefix: "/glossary",   // URL path for the index and data routes (default: "/glossary")
})
```

## Source-level transform (for `.md` endpoints, `llms.txt`, etc.)

If your docs site exposes raw markdown (e.g. a `/{path}.md` API endpoint, or a `llms.txt` generator), you can resolve `[label](glossary:slug)` links to real URLs in that output using the exported transform. This runs on the raw markdown source, not the HTML render pipeline.

```ts
import {
  loadGlossaryMap,
  resolveGlossaryLinks,
} from "starlight-glossary/transform";

const glossary = await loadGlossaryMap();
const transformed = resolveGlossaryLinks(entry.body, glossary, {
  siteOrigin: "https://docs.example.com",
});
// `[TLS](glossary:tls)` → `[TLS](https://en.wikipedia.org/wiki/Transport_Layer_Security)`
```

Options:

| Option | Default | Description |
|---|---|---|
| `siteOrigin` | `""` | Origin for the fallback URL |
| `wikipediaBase` | `"https://en.wikipedia.org/wiki/"` | Base URL for Wikipedia links |
| `fallbackHref` | `(slug) => `${siteOrigin}/glossary#${slug}`` | Called when the entry has no `wikipedia` field |
| `linkProtocol` | `"glossary"` | The protocol in source links (`[…](glossary:slug)`) |

When the glossary entry has a `wikipedia` field, it resolves to `https://en.wikipedia.org/wiki/<slug>` (spaces normalized to `_`). Otherwise it falls back to the on-site glossary anchor.

## How it works

- A **remark plugin** rewrites `[label](glossary:slug)` markdown links into `/glossary#slug` links with `data-glossary-term` attributes.
- An **Astro integration** injects two routes — `/glossary` (index page) and `/glossary/data.json` (compact definitions for the tooltip).
- A **client-side script** (~200 lines vanilla JS) attaches hover/tap behavior to any `.sl-glossary-term` link, fetches the data JSON once, and shows a popover.

## License

MIT © Eric Andrechek
