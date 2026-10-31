// Turns a line of OCR text like "H SVI EN 086/198" into a card match, correcting common misreads.
// Works in the browser (window.CardParse) and in Node (module.exports) so it can be tested.
(function (root) {
  const TO_DIGIT = { O: "0", Q: "0", D: "0", U: "0", I: "1", L: "1", T: "1", "|": "1", J: "1", Z: "2", S: "5", B: "8", G: "6", A: "4" };
  const CODE_SWAPS = { "0": ["O"], O: ["0"], "1": ["I", "L"], I: ["1", "L", "T"], L: ["I", "1"], "5": ["S"], S: ["5"], "8": ["B"], B: ["8"], "2": ["Z"], Z: ["2"], "6": ["G"], G: ["6"], V: ["Y", "W"], Y: ["V"], W: ["V"], M: ["N", "H"], N: ["M", "H"], H: ["M", "N"], E: ["F"], F: ["E"], R: ["P"], P: ["R"], C: ["G", "O"] };
  const LANG_TOKENS = new Set(["EN", "FN", "EH", "EM", "ENI", "EW", "BN", "CN", "E N"]);

  function digits(s) {
    return String(s).toUpperCase().split("").map(ch => (/[0-9]/.test(ch) ? ch : TO_DIGIT[ch] || "")).join("");
  }
  function lev(a, b) {
    const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  // Best known set code for an OCR'd token, or null.
  function fixCode(tok, codes) {
    if (!tok) return null;
    tok = tok.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (codes.has(tok)) return tok;
    // single-character swaps (misread letter/digit look-alikes)
    for (let i = 0; i < tok.length; i++) for (const r of CODE_SWAPS[tok[i]] || []) {
      const t = tok.slice(0, i) + r + tok.slice(i + 1); if (codes.has(t)) return t;
    }
    // a stray regulation-mark letter glued to the front ("HSVI")
    if (tok.length >= 4 && codes.has(tok.slice(1))) return tok.slice(1);
    // edit distance 1, only if unambiguous
    const near = [...codes].filter(c => Math.abs(c.length - tok.length) <= 1 && lev(c, tok) === 1);
    return near.length === 1 ? near[0] : null;
  }

  // Returns {code, num, total, raw} for the most plausible reading, or null.
  function parseLine(text, codes) {
    const up = String(text || "").toUpperCase().replace(/[‐-―]/g, "-").replace(/[\\]/g, "/");
    const tokens = up.split(/[^A-Z0-9/|]+/).filter(Boolean);
    const tries = [];
    // 1) token next to a language marker:  CODE EN NUM/TOTAL
    for (let i = 0; i < tokens.length; i++) {
      if (!LANG_TOKENS.has(tokens[i])) continue;
      const before = tokens[i - 1], after = tokens.slice(i + 1).join("");
      tries.push([before, after]);
    }
    // 2) glued forms like "SVIEN086/198" or "SVI EN086/198"
    const glued = up.replace(/\s+/g, " ");
    const m = glued.match(/([A-Z0-9]{2,5})\s?[EF][NHM]\s?([0-9OILSBZQD|]{1,3}(?:\s?\/\s?[0-9OILSBZQD|]{2,3})?)/);
    if (m) tries.push([m[1], m[2]]);
    for (const [cTok, nTok] of tries) {
      if (!cTok || !nTok) continue;
      // the code token can carry a glued language marker ("SVIEN")
      let code = fixCode(cTok, codes) || fixCode(cTok.replace(/[EF][NHM]$/, ""), codes);
      if (!code) continue;
      const [a, b] = nTok.split("/");
      const num = digits(a).slice(0, 3);
      const total = b ? digits(b).slice(0, 3) : "";
      if (!num) continue;
      return { code, num, total, raw: text.trim() };
    }
    return null;
  }

  // Look up a parsed reading in the card index. Returns matching cards (possibly several sets share a code).
  function lookup(read, index) {
    const sets = index.codes[read.code] || [];
    const want = read.num.replace(/^0+(?=\d)/, "");
    let out = [];
    for (const s of sets) for (const c of s.cards) {
      if (c[0].replace(/\D/g, "").replace(/^0+(?=\d)/, "") === want && /^\d+$/.test(c[0].replace(/^0+/, "") || "0"))
        out.push({ set: s, num: c[0], name: c[1], rarity: c[2], type: c[3], variants: c[4] });
    }
    // the printed total disambiguates sets that share a code (30th main set /128 vs Classic /030)
    if (out.length > 1 && read.total) {
      const t = +read.total; const byTotal = out.filter(c => c.set.off === t);
      if (byTotal.length) out = byTotal;
    }
    return out;
  }

  const api = { parseLine, lookup, fixCode, digits };
  if (typeof module !== "undefined") module.exports = api; else root.CardParse = api;
})(this);
