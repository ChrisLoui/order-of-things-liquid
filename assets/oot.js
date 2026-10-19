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
    this.caption = this.querySelector('[data-caption-label]');
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
 * <oot-accordion>: the details rows (Figma Accordion Row 14:2815), whose body eases
 * open over 200ms in every browser, as round 1's Collapsible does. The rows are
 * <details name>, so without JS they still open natively, one at a time. This takes
 * over the one-open rule from the name attribute, so the row closing animates too.
 */
class OotAccordion extends HTMLElement {
  connectedCallback() {
    this.rows = Array.from(this.querySelectorAll(':scope > details'));
    this.rows.forEach((row) => row.removeAttribute('name'));

    this.listeners = new AbortController();
    this.addEventListener('click', (event) => this.onClick(event), { signal: this.listeners.signal });
  }

  disconnectedCallback() {
    this.listeners?.abort();
  }

  onClick(event) {
    const row = event.target.closest('summary')?.parentElement;
    if (!this.rows.includes(row)) return;

    event.preventDefault();
    // A row mid-close still has [open], so read the state it's heading to.
    const opening = !row.open || row.hasAttribute('data-closing');
    if (opening) {
      this.rows.forEach((other) => {
        if (other !== row && other.open) this.toggleRow(other, false);
      });
    }
    this.toggleRow(row, opening);
  }

  /** Animates the row's height between its summary and its full content. */
  toggleRow(row, open) {
    const start = row.offsetHeight;
    row.animation?.cancel();
    row.toggleAttribute('data-closing', !open);
    if (open) row.open = true;

    const border = row.offsetHeight - row.clientHeight;
    const end = open ? row.offsetHeight : row.querySelector('summary').offsetHeight + border;
    const finish = () => {
      row.animation = null;
      row.style.overflow = '';
      row.removeAttribute('data-closing');
      if (!open) row.open = false;
    };

    if (prefersReducedMotion() || start === end) {
      finish();
      return;
    }

    row.style.overflow = 'hidden';
    row.animation = row.animate({ height: [`${start}px`, `${end}px`] }, { duration: 200, easing: 'ease-out' });
    row.animation.onfinish = finish;
  }
}

customElements.define('oot-accordion', OotAccordion);

/**
 * <oot-purchase>: the buy panel around the {% form 'product' %} (snippets/oot-purchase-form).
 * Keeps the purchase heading, price and button in step with the selected option, using
 * the strings Liquid rendered onto each radio, and submits through the AJAX Cart API.
 * The header's cart count refreshes from the same request (Section Rendering API).
 * Fires "oot:purchase-change" with the current state, for the sticky buy bar.
 */
class OotPurchase extends HTMLElement {
  connectedCallback() {
    this.form = this.querySelector('form[data-oot-product-form]');
    if (!this.form) return;

    this.submitButton = this.form.querySelector('[data-submit]');
    this.buttonLabel = this.form.querySelector('[data-button-label]');
    this.planInput = this.form.querySelector('[data-plan-input]');
    this.status = this.form.querySelector('[data-status]');
    this.pending = false;

    this.listeners = new AbortController();
    const { signal } = this.listeners;
    this.form.addEventListener('change', () => {
      this.showStatus('');
      this.update();
    }, { signal });
    this.form.addEventListener('submit', (event) => this.onSubmit(event), { signal });
    this.update();
  }

  disconnectedCallback() {
    this.listeners?.abort();
  }

  /** The radio whose strings apply: the frequency while subscribing, else the option. */
  get selection() {
    const option = this.form.querySelector('[name="oot_purchase"]:checked');
    if (option?.value === 'subscribe') return this.form.querySelector('[name="oot_frequency"]:checked');
    return option;
  }

  update() {
    const selection = this.selection;
    if (!selection) return;
    const { heading, price, priceNote, button, planId } = selection.dataset;
    const subscribing = selection.name === 'oot_frequency';

    this.setText('[data-purchase-heading]', heading);
    this.setText('[data-oot-price]', price);
    this.setText('[data-oot-price-note]', priceNote);

    // A subscription can only be bought through a selling plan (a subscription app).
    if (this.planInput) {
      this.planInput.disabled = !(subscribing && planId);
      this.planInput.value = planId ?? '';
    }

    // Coming soon and sold out keep their server-rendered label and stay disabled.
    const available = this.dataset.status === 'available';
    const canBuy = available && (!subscribing || Boolean(planId));
    if (available && this.buttonLabel) this.buttonLabel.textContent = button;
    if (this.submitButton) {
      this.submitButton.disabled = !canBuy || this.pending;
      this.submitButton.setAttribute('aria-busy', String(this.pending));
    }

    /** Read by the sticky bar when it connects after this element. */
    this.state = {
      label: this.buttonLabel?.textContent ?? '',
      price,
      canBuy,
      pending: this.pending,
      error: this.status && !this.status.classList.contains('oot-visually-hidden') ? this.status.textContent : '',
    };
    this.dispatchEvent(new CustomEvent('oot:purchase-change', { bubbles: true, detail: this.state }));
  }

  setText(selector, text) {
    const element = this.querySelector(selector);
    if (element && text !== undefined) element.textContent = text;
  }

  /** @param {SubmitEvent} event */
  async onSubmit(event) {
    event.preventDefault();
    if (this.pending) return;

    const header = document.querySelector('[data-site-header]')?.closest('.shopify-section');
    const headerId = header?.id.replace('shopify-section-', '');
    const body = new FormData(this.form);
    if (headerId) {
      body.append('sections', headerId);
      // Keep the query (?view= during preview) so the sections render for this exact page.
      body.append('sections_url', window.location.pathname + window.location.search);
    }

    this.pending = true;
    this.showStatus('');
    this.update();

    try {
      const response = await fetch(`${window.Shopify?.routes?.root ?? '/'}cart/add.js`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.description || result.message);

      const fresh = headerId && result.sections?.[headerId];
      const count = fresh && new DOMParser().parseFromString(fresh, 'text/html').getElementById('oot-cart-count');
      if (count) document.getElementById('oot-cart-count')?.replaceWith(count);
      this.showStatus(this.dataset.added, { visible: false });
    } catch (error) {
      this.showStatus(error.message || this.dataset.error, { visible: true });
    } finally {
      this.pending = false;
      this.update();
    }
  }

  /** One status region: errors show; success is announced to screen readers only. */
  showStatus(message, { visible = true } = {}) {
    if (!this.status) return;
    this.status.textContent = message ?? '';
    this.status.classList.toggle('oot-visually-hidden', !visible);
  }
}

customElements.define('oot-purchase', OotPurchase);

/**
 * <oot-sticky-bar>: shows once the buy panel's button has scrolled under the sticky
 * header, and hides when it comes back. Its button submits the panel's form (one
 * add-to-cart path); label, price and state mirror <oot-purchase>. A composition switch
 * replaces the panel, so the bar re-binds whenever a different panel reports in.
 */
class OotStickyBar extends HTMLElement {
  connectedCallback() {
    this.button = this.querySelector('[data-submit]');
    this.label = this.querySelector('[data-label]');
    this.prices = this.querySelectorAll('[data-price]');
    this.error = this.querySelector('[data-error]');

    this.listeners = new AbortController();
    document.addEventListener('oot:purchase-change', (event) => this.onPurchaseChange(event), {
      signal: this.listeners.signal,
    });
    const purchase = document.querySelector('oot-purchase');
    if (purchase?.state) this.bind(purchase, purchase.state);
  }

  disconnectedCallback() {
    this.listeners?.abort();
    this.stopObserving();
  }

  /** @param {CustomEvent} event */
  onPurchaseChange(event) {
    this.bind(event.target, event.detail);
  }

  bind(purchase, state) {
    if (purchase !== this.purchase && purchase.isConnected) {
      this.purchase = purchase;
      const form = purchase.querySelector('form[data-oot-product-form]');
      if (form?.id) this.button?.setAttribute('form', form.id);
      this.observe(form?.querySelector('[data-submit]'));
    }
    this.render(state);
  }

  render({ label, price, canBuy, pending, error }) {
    if (this.label) this.label.textContent = label;
    this.prices.forEach((element) => (element.textContent = price));
    if (this.error) this.error.textContent = error;
    if (this.button) {
      this.button.disabled = !canBuy || pending;
      this.button.setAttribute('aria-busy', String(pending));
    }
  }

  /**
   * "Scrolled past" means the panel's button has gone up under the sticky header, so
   * the bar doesn't show on first load while the button is still below the fold. The
   * header's height changes at 1024px, so it's measured, and the observer is rebuilt
   * whenever the header resizes (round-1 lesson).
   */
  observe(target) {
    this.stopObserving();
    if (!target) return;
    const header = document.querySelector('[data-site-header]');
    let observedHeight;

    const build = () => {
      const headerHeight = header?.offsetHeight ?? 0;
      if (headerHeight === observedHeight) return; // width-only resize
      observedHeight = headerHeight;
      this.intersection?.disconnect();
      this.intersection = new IntersectionObserver(
        ([entry]) => this.setVisible(!entry.isIntersecting && entry.boundingClientRect.top < headerHeight),
        { rootMargin: `-${headerHeight}px 0px 0px 0px` }
      );
      this.intersection.observe(target);
    };

    build();
    this.resize = new ResizeObserver(build);
    if (header) this.resize.observe(header);
  }

  stopObserving() {
    this.intersection?.disconnect();
    this.resize?.disconnect();
    this.intersection = this.resize = undefined;
  }

  setVisible(visible) {
    this.toggleAttribute('data-visible', visible);
    this.inert = !visible;
    this.setAttribute('aria-hidden', String(!visible));
  }
}

customElements.define('oot-sticky-bar', OotStickyBar);

/**
 * Composition switching without a reload ("like turning the pages of one book").
 * Scent tiles are plain links. On click, every [data-oot-product-section] on the page
 * is re-rendered for the target product through the Section Rendering API
 * (?sections=id1,id2) and swapped in place, then the URL is pushed. All compositions
 * share this template, so the same section IDs exist on every product page.
 * Any failure falls back to normal navigation. Links marked data-oot-scroll="top"
 * (switches started outside the hero, like collection cards) land at the top of the
 * new page, as a normal navigation would; scent tiles keep the scroll position.
 */
const sectionHtmlCache = new Map();
let latestSwitch = 0;

function productSectionIds() {
  return Array.from(document.querySelectorAll('[data-oot-product-section]'), (el) => el.dataset.sectionId)
    .filter(Boolean)
    // The Section Rendering API renders at most 5 sections per request. In use: 4 of 5
    // (hero, brand story, collection, sticky bar), so one more product section fits.
    .slice(0, 5);
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

async function switchProduct(href, { push, scrollTop = false, pointer = false }) {
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
  if (scrollTop) window.scrollTo({ top: 0, behavior: 'instant' });
  focusCurrentTile(pointer);
}

/**
 * The clicked tile was replaced, so focus moves to the new selected tile. After a
 * pointer switch it gets no focus ring: Safari ignores focusVisible, so the tile is
 * also marked until the next keydown or blur, and the scent tile CSS hides the ring.
 */
function focusCurrentTile(pointer) {
  const tile = document.querySelector('[data-oot-switch][aria-current="page"]');
  if (!tile) return;
  if (pointer) {
    tile.setAttribute('data-oot-pointer-focus', '');
    const unmark = () => tile.removeAttribute('data-oot-pointer-focus');
    tile.addEventListener('keydown', unmark, { once: true });
    tile.addEventListener('blur', unmark, { once: true });
  }
  tile.focus({ preventScroll: true, focusVisible: !pointer });
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
    // A keyboard-activated link reports click detail 0.
    switchProduct(link.href, { push: true, scrollTop: link.dataset.ootScroll === 'top', pointer: event.detail > 0 });
  });

  // Fetch on intent, so the click usually finds the response already cached.
  const prefetch = (event) => {
    const link = switchLinkFrom(event);
    if (link && link.getAttribute('aria-current') !== 'page') fetchSections(link.href).catch(() => {});
  };
  document.addEventListener('pointerover', prefetch, { passive: true });
  document.addEventListener('focusin', prefetch);

  window.addEventListener('popstate', (event) => {
    if (event.state?.ootProduct) switchProduct(window.location.href, { push: false, pointer: true });
  });
}
