/*
 * Order of Things storefront behavior: vanilla custom elements, no build step.
 * Each element enhances markup that already works without JavaScript.
 */

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * <oot-carousel>: the mobile gallery (Figma 14:3885). The track is a CSS scroll-snap
 * strip, so swiping is native; this adds the arrows, the "01 / 05" counter with the
 * slide caption, and the segmented indicator.
 */
class OotCarousel extends HTMLElement {
  connectedCallback() {
    this.track = this.querySelector('[data-track]');
    if (!this.track) return;

    this.slides = Array.from(this.track.children);
    this.prev = this.querySelector('[data-prev]');
    this.next = this.querySelector('[data-next]');
    this.counter = this.querySelector('[data-counter]');
    this.caption = this.querySelector('[data-caption]');
    this.dots = Array.from(this.querySelectorAll('.oot-carousel__dot'));
    this.index = 0;

    this.listeners = new AbortController();
    const { signal } = this.listeners;
    this.track.addEventListener('scroll', () => this.onScroll(), { passive: true, signal });
    this.prev?.addEventListener('click', () => this.goTo(this.index - 1), { signal });
    this.next?.addEventListener('click', () => this.goTo(this.index + 1), { signal });
  }

  disconnectedCallback() {
    this.listeners?.abort();
  }

  /** Keeps the index on a real slide: elastic overscroll can round past the ends. */
  clamp(index) {
    return Math.min(this.slides.length - 1, Math.max(0, index));
  }

  goTo(index) {
    const width = this.track.clientWidth;
    if (width === 0) return;
    this.track.scrollTo({
      left: this.clamp(index) * width * (getComputedStyle(this).direction === 'rtl' ? -1 : 1),
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }

  onScroll() {
    // Hidden from 1024px up (display: none), where clientWidth is 0.
    const width = this.track.clientWidth;
    if (width === 0) return;
    this.update(this.clamp(Math.round(Math.abs(this.track.scrollLeft) / width)));
  }

  update(index) {
    if (index === this.index) return;
    this.index = index;
    if (this.counter) this.counter.textContent = String(index + 1).padStart(2, '0');
    if (this.caption) this.caption.textContent = this.slides[index].dataset.caption ?? '';
    this.dots.forEach((dot, i) => dot.classList.toggle('is-active', i === index));
    if (this.prev) this.prev.disabled = index === 0;
    if (this.next) this.next.disabled = index === this.slides.length - 1;
  }
}

customElements.define('oot-carousel', OotCarousel);

/**
 * Composition switching without a reload ("like turning the pages of one book").
 * Scent tiles are plain links. On click, every [data-oot-product-section] on the page
 * is re-rendered for the target product through the Section Rendering API
 * (?sections=id1,id2) and swapped in place, then the URL is pushed. All compositions
 * share this template, so the same section IDs exist on every product page.
 * Any failure falls back to normal navigation.
 */
const sectionHtmlCache = new Map();
let latestSwitch = 0;

function productSectionIds() {
  return Array.from(document.querySelectorAll('[data-oot-product-section]'), (el) => el.dataset.sectionId)
    .filter(Boolean)
    .slice(0, 5); // The Section Rendering API renders at most 5 sections per request.
}

/** Keeps ?view= (alternate template preview) on links until the template is assigned. */
function withCurrentView(href) {
  const url = new URL(href, window.location.href);
  const view = new URL(window.location.href).searchParams.get('view');
  if (view && !url.searchParams.has('view')) url.searchParams.set('view', view);
  return url;
}

function fetchSections(href) {
  const url = withCurrentView(href);
  url.searchParams.set('sections', productSectionIds().join(','));
  const key = url.toString();

  if (!sectionHtmlCache.has(key)) {
    const request = fetch(key).then((response) => {
      if (!response.ok) throw new Error(`Section request failed: ${response.status}`);
      return response.json();
    });
    request.catch(() => sectionHtmlCache.delete(key));
    sectionHtmlCache.set(key, request);
  }
  return sectionHtmlCache.get(key);
}

async function switchProduct(href, { push }) {
  const switchId = ++latestSwitch;
  const target = withCurrentView(href);

  let sections;
  try {
    sections = await fetchSections(href);
  } catch {
    window.location.assign(target);
    return;
  }
  // A newer click won; drop this response.
  if (switchId !== latestSwitch) return;

  const parser = new DOMParser();
  let title;
  for (const [id, html] of Object.entries(sections)) {
    const live = document.getElementById(`shopify-section-${id}`);
    const fresh = html && parser.parseFromString(html, 'text/html').getElementById(`shopify-section-${id}`);
    if (!live || !fresh) {
      window.location.assign(target);
      return;
    }
    live.replaceChildren(...fresh.childNodes);
    title ??= live.querySelector('[data-page-title]')?.dataset.pageTitle;
  }

  if (title) document.title = title;
  if (push) history.pushState({ ootProduct: true }, '', target);
  document.querySelector('[data-oot-switch][aria-current="page"]')?.focus({ preventScroll: true });
}

/** @param {Event} event */
function switchLinkFrom(event) {
  return event.target instanceof Element ? event.target.closest('a[data-oot-switch]') : null;
}

// Registered once for the whole document, so any a[data-oot-switch] (scent tiles,
// collection cards, the sticky bar) switches in place, and Back switches exactly once.
// Section swaps replace the links but never these listeners.
if (document.querySelector('[data-oot-product-section]')) {
  // Mark the entry the page loaded with, so Back can return to it.
  if (!history.state?.ootProduct) history.replaceState({ ootProduct: true }, '');

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const link = switchLinkFrom(event);
    if (!link) return;
    event.preventDefault();
    if (link.getAttribute('aria-current') === 'page') return;
    switchProduct(link.href, { push: true });
  });

  // Fetch on intent, so the click usually finds the response already cached.
  const prefetch = (event) => {
    const link = switchLinkFrom(event);
    if (link && link.getAttribute('aria-current') !== 'page') fetchSections(link.href).catch(() => {});
  };
  document.addEventListener('pointerover', prefetch, { passive: true });
  document.addEventListener('focusin', prefetch);

  window.addEventListener('popstate', (event) => {
    if (event.state?.ootProduct) switchProduct(window.location.href, { push: false });
  });
}
