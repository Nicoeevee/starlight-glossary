# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] — 2026-04-20

### Fixed

- **Lint now sees text hidden by autotag.** Lint was running *after* autotag, which mutates entire text-node values into HTML nodes. Lint correctly skips HTML nodes — but as a side effect, every plain word that happened to share a paragraph with an autotagged term was invisible to lint. Result: the more glossary entries you had, the more lint candidates you couldn't see. Reordering the remark pipeline (lint between explicit-link and autotag) makes lint see the original text every time. Counts are now deterministic regardless of glossary state. Side effect: existing consumers will see *more* lint findings on the next build — those are real terms that were silently hidden.

### Added

- **`lint.acronymExpansions`** option. Map of acronym → expanded form. When auto-discover fails for an acronym (disambiguation page, 404, or fetch error) and the acronym has a configured expansion, the plugin retries the Wikipedia query with the expansion (e.g. `"AES"` → `"Advanced Encryption Standard"`). If the expansion ALSO fails, a *stub* entry is created with the expansion as the term and the acronym as an alias, ready for the user to fill in `definition` manually. Useful for acronyms with no dedicated Wikipedia article (`SOPS`, `JWKS`, …) that you still want to spell out.
- **Auto-stubbed report section.** `.astro/glossary-lint.md` now has a fourth section listing terms that became stub entries — separate from auto-added (real Wikipedia hits) and failed (still need attention).
- **Visual separators in the build log.** `━━━ lint.autoDiscover: submitting N finding(s) ━━━` / `━━━ lint.autoDiscover: done ━━━` make the auto-discover phase impossible to miss in CI logs.

## [1.2.0] — 2026-04-20

### Added

- **`lint.autoDiscover`** option (default: `false`). When true, every lint finding is submitted to the Wikipedia discovery pipeline at end of build. Unambiguous hits get auto-added to `glossary.json` + `glossary-cache.json` with the Wikipedia title, description, and extract. Disambiguation pages, 404s, and fetch errors are logged with a clear reason and the term stays in the lint report. Closes the loop: write prose → build → glossary grows itself.
- **Structured lint report.** `.astro/glossary-lint.md` now has three sections when `autoDiscover` is enabled:
  - **Auto-added this build** — a table with the slug, one-liner description, and clickable Wikipedia URL so the user can audit each auto-add
  - **Auto-discover failed** — terms that hit a disambiguation page, 404, or fetch error, with the reason
  - **Still untagged candidates** — the usual heuristic findings

### Reported match log

When a term auto-adds successfully, the build log prints:
```
lint.autoDiscover: auto-added 5 term(s):
  · Secure Shell — Cryptographic network protocol
    https://en.wikipedia.org/wiki/Secure_Shell
  · …
```

so the match can be sanity-checked at a glance without opening the report file.

## [1.1.3] — 2026-04-20

### Changed

- Replaced project-specific example terms (carried over from the original author's private docs corpus) with generic placeholders (`"Widget Factory"`) throughout tests, comments, and CHANGELOG entries. No behaviour change.

### Added

- New `lint.test.ts` cases confirming the lint collector correctly skips:
  - `heading` subtrees (title-case headings no longer produce proper-noun noise)
  - `code` blocks and `inlineCode` (technical tokens in code can't leak into lint findings)
  - `link` text (nav/prose link labels don't count)

## [1.1.2] — 2026-04-20

### Fixed

- **Autotag overlap resolution no longer silently favours case-sensitive aliases.** Previous versions collected case-sensitive matches first and dropped any overlapping case-insensitive match, even when the CI match was longer and more specific. Result: glossary with both `"IP"` (case-sensitive) and `"IP routing"` (case-insensitive) would tag the shorter `"IP"` inside text matching the full `"IP routing"` phrase. Now the rule is "earliest start wins; at a tie, longer match wins" — the phrase wins as users expect.
- **Proper-noun lint over-counted sentence starters.** Variants like `"The Widget Factory"`, `"Each Widget Factory"`, `"A Widget Factory"` were each being counted as distinct proper nouns at occurrence 1 instead of all contributing to `"Widget Factory"`'s count. Leading stop-words (`The`, `A`, `An`, `This`, `Each`, `Every`, `Some`, `Many`, `Most`, `Any`, `Our`, `Their`, `Its`, `All`, `Few`, `Several`, …) are now stripped from the front of matches so the underlying noun is counted consistently.

### Added

- **`lint.ignore`** option. Accepts strings (exact match, case-insensitive) or RegExp patterns to suppress false-positive findings without touching `glossary.json`.
- **`US`, `UK`, `EU`** added to the baseline acronym suppression list alongside the existing conjunction/annotation shouts (`NOT`, `OK`, `TODO`, …).

### Docs

- README now explains the auto-tagging match rules (earliest start wins; at a tie longer wins; exact-case breaks length+position ties) with worked examples for nested aliases like `IP` vs `IP routing`.

## [1.1.1] — 2026-04-20

### Added

- **`lint.failOnFindings`** option (default: `false`). CI hook — throws at end of build if any untagged terms remain. Use to gate deploys on "every new term got added to glossary.json".
- **`reconcile.failOnSkips`** option (default: `false`). CI hook — throws if reconcile reported any unresolved Wikipedia-redirect divergences. Forces explicit review via `wikipediaRedirectAcknowledged`.
- **First-run dry-run default.** When `glossary-cache.json` does not yet exist, `reconcile.dryRun` is forced to `true` for that build. A fresh install of the plugin no longer silently merges entries or rewrites doc files on the very first build — the log shows what *would* happen, and the user removes the option (or sets it to `false`) on the next run to apply.
- **Shared-glossary support.** `indexFile` / `cacheFile` accept absolute paths or paths outside the project root, so one `glossary.json` can be shared across multiple Astro sites in a monorepo. Documented in README.
- **`--sl-glossary-*` CSS variables.** Tooltip colours, radii, shadow, and term-accent resolve through themeable vars (falling back to Starlight's `--sl-color-*` palette). Consumers with custom Starlight themes can retheme without overriding selectors.
- **Improved accessibility on the tooltip popover.** Popover is now `role="dialog"` with `aria-modal="false"` and `aria-labelledby` pointing at the heading; term links carry `aria-haspopup="dialog"`, `aria-controls`, and `aria-expanded`. Documented a known keyboard-navigation limitation for future work.

### Changed

- `path.join(root, indexFile)` → `path.resolve(root, indexFile)` so absolute paths aren't clobbered.

## [1.1.0] — 2026-04-20

### Added

- **Test suite** (vitest, 150+ tests) covering `remark.ts`, `autotag.ts`, `reconcile.ts`, `data.ts`, `validate.ts`. `pnpm test` runs them all.
- **Schema validation** for `glossary.json` and `glossary-cache.json` at startup. Malformed files produce a clear, path-annotated error (e.g. `terms["tls"].caseSensitive: expected boolean`) instead of cryptic runtime failures.
- **`reconcile.dryRun`** option (default: `false`). When `true`, the reconcile pass logs what merges/renames/doc-rewrites it would perform without modifying anything. Useful for preview before opting in to auto-application.
- **`reconcile.enabled`** option (default: `true`). Set to `false` to skip the reconcile pass entirely; cache-fill still runs.
- **`reconcile.rewriteDocRefs`** option (default: `true`). Set to `false` to keep merges in `glossary.json` but stop rewriting `[label](glossary:old-slug)` references in `src/content/docs/`. The mergedInto stub still forwards links at render time.
- **`wikipedia.enabled`** option (default: `true`). Set to `false` for offline / air-gapped builds — no network calls; tooltips show whatever's already cached.
- **`wikipedia.strict`** option (default: `false`). When `true`, fetch errors during cache-fill or discovery throw and fail the build (recommended for CI).
- **`wikipedia.timeoutMs`** option (default: `10000`). Per-request timeout. Hitting the timeout is treated as a transient error and retries with exponential backoff.
- **`wikipediaRedirectAcknowledged`** field on glossary entries. Set this to the cached Wikipedia title to silence the "term differs from Wikipedia" warning for entries you intentionally keep at a non-canonical name (e.g. an entry pointing at a related but differently-titled article). Warning resumes if the cached title later changes again.
- **Per-page autotag opt-out** via `glossary: false` in markdown frontmatter.
- **Inline autotag opt-out** via `<!-- glossary-off -->` and `<!-- glossary-on -->` HTML comment markers in markdown source.
- **GitHub Actions CI** running typecheck + test on every push and pull request.

### Fixed

- `mergeDuplicateArticles` (the pre-pass that folds entries already pointing at the same Wikipedia article) was mutating the index but never setting the outer `mutated` flag. Result: the merge happened in memory but never persisted to `glossary.json`, so the entries reappeared on the next run. Caught by the new test suite.
- Wikipedia fetches now respect a per-request timeout (10s by default) so a single hung request can't block the whole build.

### Changed

- `tsconfig.json` no longer extends `astro/tsconfigs/strict`. Plugin code is type-checked against a self-contained config to avoid pulling Starlight's whole `.ts` source through `tsc --noEmit`.
- `fetchManyWikipedia` and `fetchWikipedia` now accept a `FetchOptions` parameter (`timeoutMs`).

## [1.0.14]

- Symmetric URL-tail handling for `glossary:` references. Both `glossary:NewConcept` and `glossary:brand-new-term` now use the URL tail as the Wikipedia query hint when the slug isn't in the existing glossary.

## [1.0.13]

- Resolution order: known glossary slug first, Wikipedia article fallback second.

## [1.0.12]

- `glossary:Article#Section` syntax fully automatic. Per-alias fragments are stored on the entry's `aliasFragments` map and carried through to the tooltip's Wikipedia link.

## [1.0.11]

- `groupWith` children render as a compact "Variants:" list under the parent on the `/glossary` page (no more nested headings + duplicate summaries).

## [1.0.10]

- Pre-pass that merges entries already pointing at the same Wikipedia article.
- Doc-reference rewrite: `[x](glossary:old-slug)` in source becomes `[x](glossary:new-slug)` automatically after a merge.

## [1.0.9]

- Conservative reconcile of Wikipedia redirects: rename only on case-only or prefix matches; merge only when fragment-free; otherwise SKIP and log.

## [1.0.8]

- Alphabetic A–Z sections on `/glossary`, jump-to-letter nav.
- Wikipedia "description" rendered as italic tagline subtitle.

## [1.0.7]

- `data.json` served with `Cache-Control: max-age=0, must-revalidate`. Tooltip client uses `cache: "no-cache"`. Stale empty responses no longer linger in the browser cache.

## [1.0.6]

- Vite `server.fs.allow` is now extended via `configResolved` (push), not replaced via `config()`. Fixes 403s on consumer assets when the plugin is installed via `link:`.

## [1.0.5]

- Event-driven dev-mode finalize: debounced timer scheduled by remark-pass `onReference` callback. Replaces the 5s poll.

## [1.0.4]

- Cache holes filled at `astro:config:setup` (before route render), not `astro:build:done`. Fixes empty `/glossary` and tooltip bodies on cold builds.
- Alias cleanup: underscored, `%28`/`%29`-encoded duplicates merged.

## [1.0.3]

- `fillCacheHoles` for known-slug entries. Robust Wikipedia client with retry/backoff on 429/5xx/network errors.

## [1.0.2]

- Documentation accuracy sweep.

## [1.0.1]

- MDX compatibility: autotag mutates text→html in place rather than splicing the parent.

## [1.0.0]

- Full feature rewrite: new `glossary:` link syntax, auto-tag of plain-text mentions, Wikipedia discovery for unknown refs, hover-based read-state tracking.

## [0.2.x]

- Switch from per-term `.md` files (content collection) to a single `glossary.json` + Wikipedia cache file.

## [0.1.x]

- Initial release: per-term content collection, basic tooltip rendering.
