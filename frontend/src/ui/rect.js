// Rect-cut layout: a panel's content is laid out by cutting slices off a rectangle.
export class Rect {
  constructor(x, y, w, h) { this.x = x; this.y = y; this.w = Math.max(0, w); this.h = Math.max(0, h); }
  get r() { return this.x + this.w; }
  get b() { return this.y + this.h; }
  get cx() { return this.x + this.w / 2; }
  get cy() { return this.y + this.h / 2; }
  clone() { return new Rect(this.x, this.y, this.w, this.h); }
  contains(x, y) { return x >= this.x && x <= this.r && y >= this.y && y <= this.b; }
  inset(left, top = left, right = left, bottom = top) {
    return new Rect(this.x + left, this.y + top, this.w - left - right, this.h - top - bottom);
  }
  // Each cut shrinks this rect and returns the slice taken (gap is left between them).
  cutTop(h, gap = 0) {
    const slice = new Rect(this.x, this.y, this.w, Math.min(h, this.h));
    this.y += slice.h + gap; this.h = Math.max(0, this.h - slice.h - gap); return slice;
  }
  cutBottom(h, gap = 0) {
    const height = Math.min(h, this.h), slice = new Rect(this.x, this.b - height, this.w, height);
    this.h = Math.max(0, this.h - height - gap); return slice;
  }
  cutLeft(w, gap = 0) {
    const slice = new Rect(this.x, this.y, Math.min(w, this.w), this.h);
    this.x += slice.w + gap; this.w = Math.max(0, this.w - slice.w - gap); return slice;
  }
  cutRight(w, gap = 0) {
    const width = Math.min(w, this.w), slice = new Rect(this.r - width, this.y, width, this.h);
    this.w = Math.max(0, this.w - width - gap); return slice;
  }
  // n equal columns (or the given weights), left to right.
  cols(n, gap = 0) {
    const weights = Array.isArray(n) ? n : Array(n).fill(1), total = weights.reduce((a, b) => a + b, 0);
    const free = this.w - gap * (weights.length - 1);
    let x = this.x;
    return weights.map(weight => { const w = free * weight / total, r = new Rect(x, this.y, w, this.h); x += w + gap; return r; });
  }
}
