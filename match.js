// Artwork fingerprints and nearest-card search.
// Mirrors artfp.py, which built fp.bin from the reference card images (245×337).
(function (root) {
  const REF_W = 245, REF_H = 337, DIMS = 336;
  const ART = [0.08, 0.105, 0.92, 0.53];          // art window, as fractions of the card
  const tmp = document.createElement("canvas");
  const tctx = tmp.getContext("2d", { willReadFrequently: true });

  // Average a box of the card into a gw×gh grid (gray or RGB), the way PIL's resize + 4×4 mean does.
  function grid(src, box, gw, gh, gray) {
    const W = src.width, H = src.height;
    const x0 = Math.round(box[0] * W), y0 = Math.round(box[1] * H), x1 = Math.round(box[2] * W), y1 = Math.round(box[3] * H);
    tmp.width = gw * 4; tmp.height = gh * 4;
    tctx.imageSmoothingEnabled = true; tctx.imageSmoothingQuality = "high";
    tctx.drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, gw * 4, gh * 4);
    const d = tctx.getImageData(0, 0, gw * 4, gh * 4).data, ch = gray ? 1 : 3, out = new Float32Array(gw * gh * ch), rowLen = gw * 4 * 4;
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      let r = 0, g = 0, b = 0;
      for (let yy = 0; yy < 4; yy++) for (let xx = 0; xx < 4; xx++) {
        const p = (gy * 4 + yy) * rowLen + (gx * 4 + xx) * 4; r += d[p]; g += d[p + 1]; b += d[p + 2];
      }
      r /= 16; g /= 16; b /= 16;
      const o = (gy * gw + gx) * ch;
      if (gray) out[o] = 0.299 * r + 0.587 * g + 0.114 * b; else { out[o] = r; out[o + 1] = g; out[o + 2] = b; }
    }
    return { a: out, ch };
  }
  // Per channel: subtract the mean, divide by (std + 8). Takes out lighting and white-balance shifts.
  function norm({ a, ch }, w) {
    const n = a.length / ch, out = new Float32Array(a.length);
    for (let c = 0; c < ch; c++) {
      let m = 0; for (let i = c; i < a.length; i += ch) m += a[i]; m /= n;
      let v = 0; for (let i = c; i < a.length; i += ch) v += (a[i] - m) ** 2; const sd = Math.sqrt(v / n) + 8;
      for (let i = c; i < a.length; i += ch) out[i] = (a[i] - m) / sd * w;
    }
    return out;
  }
  // src: a canvas holding just the card, any size (it is treated as REF_W×REF_H proportions)
  function fingerprint(src) {
    const g = norm(grid(src, ART, 16, 12, true), 1.0);
    const ac = norm(grid(src, ART, 6, 4, false), 0.8);
    const cc = norm(grid(src, [0, 0, 1, 1], 4, 6, false), 0.6);
    const v = new Float32Array(DIMS); v.set(g, 0); v.set(ac, g.length); v.set(cc, g.length + ac.length);
    for (let i = 0; i < DIMS; i++) v[i] = Math.max(-127, Math.min(127, v[i] * 32));
    return v;
  }
  // Squared distance from each query to every card; keeps the best (min over queries) and returns the top k.
  function search(fp, queries, k) {
    const n = fp.length / DIMS, best = new Float32Array(n).fill(Infinity);
    for (const q of queries) {
      for (let i = 0, o = 0; i < n; i++, o += DIMS) {
        let s = 0;
        for (let j = 0; j < DIMS; j++) { const t = fp[o + j] - q[j]; s += t * t; }
        if (s < best[i]) best[i] = s;
      }
    }
    const top = [];
    for (let i = 0; i < n; i++) {
      const s = best[i];
      if (top.length < k) { top.push([i, s]); top.sort((a, b) => a[1] - b[1]); }
      else if (s < top[k - 1][1]) { top[k - 1] = [i, s]; top.sort((a, b) => a[1] - b[1]); }
    }
    return top;
  }
  root.CardMatch = { REF_W, REF_H, DIMS, fingerprint, search };
})(this);
