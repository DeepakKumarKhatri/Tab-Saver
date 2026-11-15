// A small virtual list: only the rows near the viewport exist in the DOM, so 400 or 40,000
// saved tabs scroll and filter just as fast. Rows have fixed heights (given per row type).

export class VirtualList {
  /**
   * @param {HTMLElement} scroller  the scrolling element
   * @param {{ height(row): number, key(row): string, render(row, el): void, sig?(row): string, onUpdate?(scrollTop): void, overscan?: number }} opts
   *   sig(row): a string that changes whenever the row would render differently; rows with an
   *   unchanged signature are kept as they are instead of being re-rendered.
   */
  constructor(scroller, opts) {
    this.el = scroller;
    this.opts = opts;
    this.rows = [];
    this.offsets = new Float64Array(1);
    this.pool = new Map(); // key -> element currently in the DOM
    this.free = []; // detached elements ready for reuse
    this.viewport = scroller.clientHeight;
    this.frame = 0;

    this.canvas = document.createElement("div");
    this.canvas.className = "vl-canvas";
    scroller.append(this.canvas);

    scroller.addEventListener("scroll", () => this.schedule(), { passive: true });
    new ResizeObserver(() => {
      this.viewport = scroller.clientHeight;
      this.schedule();
    }).observe(scroller);
  }

  get scrollTop() {
    return this.el.scrollTop;
  }

  set scrollTop(v) {
    this.el.scrollTop = v;
    this.update();
  }

  get totalHeight() {
    return this.offsets[this.rows.length];
  }

  setRows(rows) {
    this.rows = rows;
    const offsets = new Float64Array(rows.length + 1);
    for (let i = 0; i < rows.length; i++) offsets[i + 1] = offsets[i] + this.opts.height(rows[i]);
    this.offsets = offsets;
    this.canvas.style.height = offsets[rows.length] + "px";
    this.update();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  /** Index of the row at pixel offset y. */
  indexAt(y) {
    let lo = 0;
    let hi = this.rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  update() {
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    const top = this.el.scrollTop;
    const height = this.viewport || this.el.clientHeight;
    const over = this.opts.overscan ?? 320;
    const n = this.rows.length;
    const start = n ? this.indexAt(Math.max(0, top - over)) : 0;
    const end = n ? Math.min(n, this.indexAt(top + height + over) + 1) : 0;

    const keep = new Set();
    for (let i = start; i < end; i++) {
      const row = this.rows[i];
      const key = this.opts.key(row);
      keep.add(key);
      let el = this.pool.get(key);
      if (!el) {
        el = this.free.pop() || document.createElement("div");
        el.__row = null;
        el.__sig = null;
        el.__y = -1;
        this.pool.set(key, el);
      }
      if (el.__row !== row) {
        const sig = this.opts.sig ? this.opts.sig(row) : null;
        if (sig === null || sig !== el.__sig) this.opts.render(row, el);
        el.__sig = sig;
        el.__row = row;
      }
      const y = this.offsets[i];
      if (el.__y !== y) {
        el.style.transform = `translateY(${y}px)`;
        el.__y = y;
      }
      if (el.parentNode !== this.canvas) this.canvas.append(el);
    }
    for (const [key, el] of this.pool) {
      if (keep.has(key)) continue;
      el.remove();
      this.pool.delete(key);
      if (this.free.length < 64) this.free.push(el);
    }
    this.start = start;
    this.end = end;
    this.opts.onUpdate?.(top);
  }

  /** Scroll just enough to show row i (topInset leaves room for a sticky header). */
  ensureVisible(i, topInset = 0) {
    if (i < 0 || i >= this.rows.length) return;
    const top = this.offsets[i];
    const bottom = this.offsets[i + 1];
    const view = this.viewport || this.el.clientHeight;
    if (top - topInset < this.el.scrollTop) this.el.scrollTop = Math.max(0, top - topInset);
    else if (bottom > this.el.scrollTop + view) this.el.scrollTop = bottom - view;
    this.update();
  }

  /** Call fn(el, row) for each row currently in the DOM. */
  forEachRendered(fn) {
    for (const el of this.pool.values()) if (el.__row) fn(el, el.__row);
  }
}
