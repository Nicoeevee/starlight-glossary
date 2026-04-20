// Glossary tooltip runtime.
//
// Renders a styled popover when the user hovers (desktop) or taps
// (mobile) a `.sl-glossary-term` link. Data is fetched once from
// `/glossary/data.json` (emitted at build time) and cached in memory.
//
// Design notes:
//   - One shared popover element per page, moved under the active
//     term. Uses the native HTML Popover API (`popover="manual"`,
//     `showPopover()` / `hidePopover()`) so focus/inert/ESC are all
//     handled by the platform.
//   - Hover-intent: 150ms show delay, 250ms hide delay, cancelled if
//     the pointer crosses into the popover itself so the user can
//     click links inside.
//   - Mobile: first tap opens, tap outside closes, the link's href
//     (`/glossary#slug`) still works as a long-press fallback.
//   - No framework. ~120 lines of vanilla JS.

const SHOW_DELAY = 150;
const HIDE_DELAY = 250;
const READ_THRESHOLD_MS = 1500; // tooltip must be visible this long to count as "read"
const DATA_URL = "/glossary/data.json";
const READ_STORAGE_KEY = "sl-glossary-read";

/** @type {Promise<Record<string, GlossaryEntry>> | null} */
let dataPromise = null;

/** @type {Set<string>} */
let readTerms = loadReadTerms();

function loadReadTerms() {
  try {
    const raw = localStorage.getItem(READ_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveReadTerms() {
  try {
    localStorage.setItem(READ_STORAGE_KEY, JSON.stringify([...readTerms]));
  } catch {
    /* quota or disabled — ignore */
  }
}

function markRead(slug) {
  if (!slug || readTerms.has(slug)) return;
  readTerms.add(slug);
  saveReadTerms();
  document
    .querySelectorAll(`.sl-glossary-term[data-glossary-term="${CSS.escape(slug)}"]`)
    .forEach((el) => el.setAttribute("data-glossary-read", "true"));
}

function applyReadState() {
  if (readTerms.size === 0) return;
  document.querySelectorAll(".sl-glossary-term").forEach((el) => {
    const slug = el.getAttribute("data-glossary-term");
    if (slug && readTerms.has(slug)) {
      el.setAttribute("data-glossary-read", "true");
    }
  });
}

/**
 * @typedef {{ term: string, aliases?: string[], html: string, wikipedia?: string }} GlossaryEntry
 */

function loadData() {
  if (!dataPromise) {
    // `cache: "no-cache"` still uses the HTTP cache but always
    // validates with the server (If-None-Match). Prevents a previously
    // cached empty/partial response from blocking tooltip contents.
    dataPromise = fetch(DATA_URL, {
      credentials: "same-origin",
      cache: "no-cache",
    })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return dataPromise;
}

/** Clean up wikipedia-fragment-encoded names like `GitHub#GitHub_Actions`. */
function prettifyTerm(term) {
  return String(term || "")
    .replace(/_/g, " ")
    .replace(/#/g, " › ")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")");
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** @type {HTMLDivElement | null} */
let popover = null;
/** @type {HTMLElement | null} */
let activeTerm = null;
let hideTimer = 0;
let showTimer = 0;
let readTimer = 0;
let currentSlug = null;

function ensurePopover() {
  if (popover) return popover;
  popover = document.createElement("div");
  popover.className = "sl-glossary-popover";
  popover.setAttribute("popover", "manual");
  popover.setAttribute("role", "tooltip");
  popover.innerHTML = `
    <button type="button" class="sl-glossary-popover__close" aria-label="Close">×</button>
    <h3 class="sl-glossary-popover__term"></h3>
    <p class="sl-glossary-popover__tagline"></p>
    <div class="sl-glossary-popover__body"></div>
    <div class="sl-glossary-popover__footer"></div>
  `;
  document.body.appendChild(popover);

  popover.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  popover.addEventListener("mouseleave", () => scheduleHide());
  popover.querySelector(".sl-glossary-popover__close")?.addEventListener("click", hideNow);
  return popover;
}

function position() {
  if (!popover || !activeTerm) return;
  const rect = activeTerm.getBoundingClientRect();
  const pop = popover;
  // Measure then place below, flipping above if clipped.
  pop.style.left = "0";
  pop.style.top = "0";
  pop.style.maxWidth = `min(28rem, calc(100vw - 2rem))`;
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let left = rect.left + rect.width / 2 - pw / 2;
  left = Math.max(8, Math.min(left, vw - pw - 8));
  let top = rect.bottom + 8;
  if (top + ph > vh - 8 && rect.top - ph - 8 > 8) {
    top = rect.top - ph - 8;
  }
  pop.style.left = `${left + window.scrollX}px`;
  pop.style.top = `${top + window.scrollY}px`;
}

async function showFor(term) {
  const slug = term.getAttribute("data-glossary-term");
  if (!slug) return;
  const data = await loadData();
  // Follow mergedInto pointers so old-slug tooltips render canonical content.
  let entry = data[slug];
  const seen = new Set([slug]);
  while (entry && entry.mergedInto && !seen.has(entry.mergedInto)) {
    seen.add(entry.mergedInto);
    entry = data[entry.mergedInto];
  }
  // Resolve per-reference Wikipedia fragment: prefer the explicit
  // data-glossary-fragment attribute (set for links with the
  // Article#Section syntax), then fall back to the entry's
  // aliasFragments map keyed by the link's label text.
  let explicitFragment = term.getAttribute("data-glossary-fragment");
  if (!explicitFragment && entry?.aliasFragments) {
    const labelText = term.textContent.trim();
    if (labelText in entry.aliasFragments) {
      explicitFragment = entry.aliasFragments[labelText];
    } else {
      const lower = labelText.toLowerCase();
      for (const [k, v] of Object.entries(entry.aliasFragments)) {
        if (k.toLowerCase() === lower) { explicitFragment = v; break; }
      }
    }
  }
  const pop = ensurePopover();
  const termEl = pop.querySelector(".sl-glossary-popover__term");
  const taglineEl = pop.querySelector(".sl-glossary-popover__tagline");
  const bodyEl = pop.querySelector(".sl-glossary-popover__body");
  const footerEl = pop.querySelector(".sl-glossary-popover__footer");
  if (!termEl || !taglineEl || !bodyEl || !footerEl) return;

  if (entry) {
    termEl.textContent = prettifyTerm(entry.term);
    taglineEl.textContent = entry.description || "";
    taglineEl.style.display = entry.description ? "" : "none";
    bodyEl.innerHTML = entry.html;
    const parts = [`<a href="/glossary#${encodeURIComponent(slug)}">Read more →</a>`];
    // If this specific reference carries a fragment, build a fragment-
    // aware Wikipedia URL on top of the entry's article URL; otherwise
    // use the entry's own URL (which may already be a fragment).
    let wpUrl = entry.wikipediaUrl;
    let wpTitle = entry.wikipediaTitle;
    if (explicitFragment && entry.wikipedia) {
      const articleOnly = entry.wikipedia.split("#")[0];
      wpUrl =
        "https://en.wikipedia.org/wiki/" +
        articleOnly.replace(/ /g, "_") +
        "#" +
        explicitFragment.replace(/ /g, "_");
      wpTitle = prettifyTerm(articleOnly) + " › " + prettifyTerm(explicitFragment);
    }
    if (wpUrl) {
      const title = wpTitle || "Wikipedia";
      parts.push(
        `<a href="${wpUrl}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>`,
      );
    }
    footerEl.innerHTML = parts.join(" · ");
  } else {
    termEl.textContent = prettifyTerm(slug);
    taglineEl.style.display = "none";
    bodyEl.innerHTML = "<p><em>No definition available.</em></p>";
    footerEl.innerHTML = `<a href="/glossary#${slug}">Open glossary →</a>`;
  }

  activeTerm = term;
  currentSlug = slug;
  try {
    if (!pop.matches(":popover-open")) pop.showPopover();
  } catch {
    pop.style.display = "block";
  }
  // Position after layout so offsetWidth/Height are real.
  requestAnimationFrame(position);

  // Start a timer — if the tooltip stays visible for READ_THRESHOLD_MS the
  // user has spent long enough to count as having read it. The timer is
  // cancelled on hide.
  clearTimeout(readTimer);
  readTimer = window.setTimeout(() => markRead(slug), READ_THRESHOLD_MS);
}

function scheduleShow(term) {
  clearTimeout(hideTimer);
  clearTimeout(showTimer);
  showTimer = window.setTimeout(() => showFor(term), SHOW_DELAY);
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hideNow, HIDE_DELAY);
}

function hideNow() {
  clearTimeout(showTimer);
  clearTimeout(readTimer);
  activeTerm = null;
  currentSlug = null;
  if (!popover) return;
  try {
    if (popover.matches(":popover-open")) popover.hidePopover();
  } catch {
    popover.style.display = "none";
  }
}

function bind(term) {
  if (term.dataset.slGlossaryBound) return;
  term.dataset.slGlossaryBound = "1";
  term.addEventListener("mouseenter", () => scheduleShow(term));
  term.addEventListener("mouseleave", () => scheduleHide());
  term.addEventListener("focus", () => showFor(term));
  term.addEventListener("blur", () => scheduleHide());
  term.addEventListener("click", (e) => {
    // Touch / mouse: first interaction opens inline; subsequent tap on
    // the link (or a click with popover already open for a different
    // term) lets the default navigation happen.
    if (activeTerm !== term) {
      e.preventDefault();
      showFor(term);
    }
  });
}

function init() {
  applyReadState();
  document
    .querySelectorAll(".sl-glossary-term[data-glossary-term]")
    .forEach(bind);
  document.addEventListener("click", (e) => {
    if (!popover || !activeTerm) return;
    const t = e.target;
    if (!(t instanceof Node)) return;
    if (popover.contains(t) || activeTerm.contains(t)) return;
    hideNow();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideNow();
  });
  window.addEventListener("scroll", () => activeTerm && position(), {
    passive: true,
  });
  window.addEventListener("resize", () => activeTerm && position());
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
