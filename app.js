(() => {
const $ = id => document.getElementById(id);
const IMG_BASE = "https://assets.tcgdex.net/";
const VLABEL = {normal:"Non-holo", holo:"Holo", reverse:"Reverse", pokeball:"Poké Ball / Patterned", masterball:"Alt Ball / Alt Pattern", unset:"Finish not set", asnumbered:"As numbered"};
const PAT = {energy:"Energy symbol", quickball:"Quick Ball", loveball:"Love Ball", duskball:"Dusk Ball", friendball:"Friend Ball", pokeball:"Poké Ball",
  masterball:"Master Ball", cosmos:"Cosmos", "cracked-ice":"Cracked Ice", rainbow:"Rainbow", gold:"Gold", league:"League", galaxy:"Galaxy", tinsel:"Tinsel", "team-rocket":"Team Rocket"};
const ALWAYS_HOLO = {en:["30C"]};
const GUIDE_SIZES = [72, 82, 92];
const SCALES = [1, 0.96, 1.04];      // small framing errors: also try the card slightly zoomed in and out
const MAX_D = 90000;                 // farther than this from every card: not a card (calibrated offline)
const CLEAR_WIN = 0.8;               // best match must beat the runner-up by this ratio...
const VOTE_WINDOW = 6, VOTES_NEEDED = 3;   // or be the top guess in 3 of the last 6 frames
const SAME_CARD_COOLDOWN = 2500;

const store = {
  get(k, d){ try { const v = localStorage.getItem("scan:"+k); return v == null ? d : JSON.parse(v); } catch(e){ return d; } },
  set(k, v){ try { localStorage.setItem("scan:"+k, JSON.stringify(v)); } catch(e){} }
};
const S = {
  rows: null, fp: null, stream: null, track: null, scanning: false, busy: false, history: [],
  locked: null, pick: 0, print: null, qty: 1, auto: store.get("auto", false), prefer: store.get("prefer", "en"), twins: {},
  batch: store.get("batch", {}), lastAdded: null, guide: store.get("guide3", 1), debug: false, wake: null
};
// rows: [lang, setId, code, num, englishName, originalName, rarity, variants, imagePath, setName, officialCount]
const TAG = {en:"", ja:"JP", zh:"CH", ko:"KR", cn:"CN"};
// A Japanese card can stand in for its Chinese or Korean twin (same set code, same number, same art):
// when you're scanning Chinese or Korean, the match is shown and logged as that twin.
const R = id => {
  // id is a row number, or "row:lang" to show a Japanese row as a specific language (ja, zh or ko)
  const [i, as] = typeof id === "string" ? [+id.split(":")[0], id.split(":")[1]] : [id, null];
  const r = S.rows[i];
  const c = {i, id, lang:r[0], setId:r[1], code:r[2], num:r[3], name:r[4], orig:r[5], rarity:r[6], variants:r[7], img:r[8], setName:r[9], off:r[10]};
  const want = as || ((S.prefer === "zh" || S.prefer === "ko") ? S.prefer : null);
  const tw = want && want !== "ja" && S.twins[i]?.[want];
  if (tw) Object.assign(c, {lang:want, orig:tw[0], name:tw[1], rarity:tw[2], variants:tw[3], setName:tw[4]});
  return c;
};
// Pack rows carry their thumbnail as [packPart, offset, length] inside a pack file instead of a TCGdex path.
const PACK = { parts: {}, n: 0, urls: new Map() };
function imgOf(img){
  if (!img) return "";
  if (!Array.isArray(img)) return IMG_BASE + img + "/low.webp";
  const P = PACK.parts[img[0]]; if (!P) return "";
  const k = img.join(":"); let u = PACK.urls.get(k);
  if (!u){ u = URL.createObjectURL(new Blob([new Uint8Array(P.buf, P.imgAt + img[1], img[2])], {type:"image/webp"})); PACK.urls.set(k, u); }
  return u;
}
const imgUrl = c => imgOf(c.img);

/* ---------- prints (same rules as Card Tally) ---------- */
const titleish = s => String(s).replace(/-/g," ").replace(/\b[a-z]/g, m => m.toUpperCase());
const baseOf = v => String(v).split("+")[0];
function finishLabel(v){
  if (!v || v==="unset") return VLABEL.unset;
  if (VLABEL[v]) return VLABEL[v];
  const [main, ...stamps] = String(v).split("+"); const [base, pat] = main.split(":");
  let s = (VLABEL[base] || titleish(base)) + (pat ? " · " + (PAT[pat] || titleish(pat)) : "");
  const st = stamps.join("/").split("/").filter(Boolean);
  if (st.length) s += " · " + st.map(x => x==="1st-edition" ? "1st Edition" : titleish(x)+" stamp").join(", ");
  return s;
}
function listedPrints(c){
  let vs = [...new Set(c.variants || [])];
  if ((ALWAYS_HOLO[c.lang]||[]).includes(c.code)) vs = vs.map(v => v.replace(/^normal/, "holo"));
  const stamp = v => v.split("+").slice(1).join("+");
  if (vs.length && vs.every(v => stamp(v) && stamp(v)===stamp(vs[0]))) vs = vs.map(baseOf);
  return [...new Set(vs)];
}
const isBall = v => /ball$/.test(baseOf(v).split(":").pop());
// Common finishes the card data doesn't cover, offered after the listed prints.
function extraFinishes(L){
  if (L.includes("asnumbered")) return [];   // Gem Packs: each number is already its own foil
  const has = f => L.some(f), balls = L.filter(isBall), out = [];
  if (!has(v => baseOf(v).startsWith("normal"))) out.push("normal");
  if (!has(v => baseOf(v).startsWith("holo"))) out.push("holo");
  if (!has(v => baseOf(v).startsWith("reverse") && !isBall(v))) out.push("reverse");
  if (!balls.some(v => baseOf(v) !== "masterball")) out.push("pokeball");
  if (!has(v => baseOf(v) === "masterball") && balls.length < 2) out.push("masterball");
  return out;
}
const firstPrint = c => listedPrints(c)[0] || "normal";

/* ---------- data ---------- */
async function loadData(){
  try {
    const [cards, fp] = await Promise.all([fetch("cards.json").then(r => r.json()), fetch("fp.bin").then(r => r.arrayBuffer())]);
    S.rows = cards.rows; S.twins = cards.twins || {}; S.fp = new Int8Array(fp);
    if (S.fp.length !== S.rows.length * CardMatch.DIMS) throw new Error("size");
    S.baseRows = S.rows; S.baseFp = S.fp;
    try { const saved = await packAll(); if (saved.length) usePacks(saved); } catch(e){}
    renderPack();
    $("startBtn").disabled = false; $("startBtn").textContent = "Start camera";
  } catch(e){ fail("Couldn't load the card list. Check your connection and reload."); $("startBtn").textContent = "Couldn't load"; }
}

/* ---------- camera ---------- */
async function startCamera(){
  $("startErr").hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) return fail("This browser can't use the camera. Open the page in Chrome over https.");
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ audio:false, video:{ facingMode:{ideal:"environment"}, width:{ideal:1280}, height:{ideal:720} } });
  } catch(e){
    return fail(e.name === "NotAllowedError" ? "Camera permission was blocked. Allow it in the browser's site settings, then try again." : "Couldn't start the camera ("+(e.name||"error")+").");
  }
  const v = $("video"); v.srcObject = S.stream; await v.play().catch(()=>{});
  S.track = S.stream.getVideoTracks()[0];
  setupTrackControls();
  $("start").hidden = true;
  try { S.wake = await navigator.wakeLock?.request("screen"); } catch(e){}
  S.scanning = true; setStatus("Looking for a card…", false, true); loop();
}
function fail(msg){ $("startErr").textContent = msg; $("startErr").hidden = false; }
function setupTrackControls(){
  const caps = S.track.getCapabilities ? S.track.getCapabilities() : {};
  if (caps.focusMode?.includes("continuous")) S.track.applyConstraints({advanced:[{focusMode:"continuous"}]}).catch(()=>{});
  if (caps.torch) $("torch").hidden = false;
  if (caps.zoom && caps.zoom.max > caps.zoom.min){
    const z = $("zoom"); z.min = caps.zoom.min; z.max = caps.zoom.max; z.step = caps.zoom.step || 0.1;
    const want = Math.min(caps.zoom.max, Math.max(caps.zoom.min, store.get("zoom", caps.zoom.min)));
    z.value = want; applyZoom(want); $("zoomWrap").hidden = false;
  }
}
function applyZoom(v){ S.track?.applyConstraints({advanced:[{zoom:+v}]}).catch(()=>{}); $("zoomVal").textContent = (+v).toFixed(1)+"×"; store.set("zoom", +v); }
$("zoom").addEventListener("input", e => applyZoom(e.target.value));
$("torch").addEventListener("click", () => {
  const on = $("torch").getAttribute("aria-pressed") !== "true";
  S.track?.applyConstraints({advanced:[{torch:on}]}).then(() => $("torch").setAttribute("aria-pressed", String(on))).catch(()=>{});
});
$("startBtn").addEventListener("click", startCamera);
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  if (S.stream && (!S.wake || S.wake.released)) { try { S.wake = await navigator.wakeLock?.request("screen"); } catch(e){} }
  if (S.scanning) loop();
});
function applyGuide(){ $("guide").style.setProperty("--gh", GUIDE_SIZES[S.guide] + "%"); }
$("guideSize").addEventListener("click", () => { S.guide = (S.guide + 1) % GUIDE_SIZES.length; store.set("guide3", S.guide); applyGuide(); });
$("debug").addEventListener("click", () => { S.debug = !S.debug; $("debug").setAttribute("aria-pressed", String(S.debug)); $("dbg").hidden = !S.debug; });
applyGuide();

/* ---------- grab the card out of the frame ---------- */
const cardCanvas = document.createElement("canvas"); cardCanvas.width = CardMatch.REF_W; cardCanvas.height = CardMatch.REF_H;
const cctx = cardCanvas.getContext("2d", { willReadFrequently: true });
function guideRect(){
  const v = $("video"), vw = v.videoWidth, vh = v.videoHeight; if (!vw) return null;
  const cr = $("cam").getBoundingClientRect(), gr = $("guide").getBoundingClientRect();
  const scale = Math.max(cr.width / vw, cr.height / vh), ox = (cr.width - vw*scale)/2, oy = (cr.height - vh*scale)/2;
  const b = 3; // inside the outline's border
  return { x:(gr.left - cr.left - ox + b)/scale, y:(gr.top - cr.top - oy + b)/scale, w:(gr.width - 2*b)/scale, h:(gr.height - 2*b)/scale };
}
function queries(){
  const g = guideRect(); if (!g) return null;
  const v = $("video"), qs = [];
  for (const s of SCALES){
    const w = g.w / s, h = g.h / s, x = g.x + (g.w - w)/2, y = g.y + (g.h - h)/2;
    cctx.fillStyle = "#282828"; cctx.fillRect(0, 0, cardCanvas.width, cardCanvas.height);
    cctx.imageSmoothingEnabled = true; cctx.imageSmoothingQuality = "high";
    cctx.drawImage(v, x, y, w, h, 0, 0, cardCanvas.width, cardCanvas.height);
    if (s === 1 && S.debug) $("dbgCanvas").getContext("2d").drawImage(cardCanvas, 0, 0);
    qs.push(CardMatch.fingerprint(cardCanvas));
  }
  return qs;
}

/* ---------- matching loop ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function loop(){
  if (S.busy) return; S.busy = true;
  try {
    while (S.scanning && !S.locked && document.visibilityState === "visible"){
      const qs = queries();
      if (!qs){ await sleep(150); continue; }
      const top = CardMatch.search(S.fp, qs, 40);   // deep enough to catch every reprint of the same art
      handleMatch(top);
      await sleep(60);   // let the page breathe between frames
    }
  } catch(e){ setStatus("Matching hit an error. Reload the page to restart it.", true); console.error(e); }
  S.busy = false;
}
function handleMatch(top){
  const [i1, d1] = top[0], [i2, d2] = top[1], c1 = R(i1), c2 = R(i2);
  const ratio = d1 / d2, sameName = c1.name === c2.name, close = d1 < MAX_D;
  const clear = close && (ratio < CLEAR_WIN || sameName);
  S.history.push(close ? { name: c1.name, d: d1, ratio: sameName ? 0.5 : ratio, clear } : null);
  if (S.history.length > VOTE_WINDOW) S.history.shift();
  if (S.debug) $("dbgText").textContent = top.slice(0, 4).map(([i, d]) => `${Math.round(d/1000)}k ${R(i).code} ${R(i).num} ${R(i).name}`).join("\n") + `\nratio ${ratio.toFixed(2)}`;
  if (!close){ S.maybe = null; $("guide").classList.remove("hit"); setStatus("Looking for a card…", false, true); return; }
  const key = "n:" + c1.name;
  if (S.lastAdded && S.lastAdded.key === key && Date.now() - S.lastAdded.t < SAME_CARD_COOLDOWN){ S.maybe = null; setStatus(`Just added ${c1.name}. Next card.`, false, true); return; }
  // Vote over the last few frames, so a wobble or a finger in one frame doesn't reset everything.
  const votes = S.history.filter(h => h && h.name === c1.name);
  const clearVotes = votes.filter(h => h.clear).length;
  const avg = f => votes.reduce((a, h) => a + h[f], 0) / votes.length;
  const steadyGuess = votes.length >= VOTES_NEEDED && avg("d") < 45000 && avg("ratio") < 0.93;
  if (clearVotes >= 2 || steadyGuess){ S.maybe = null; lock(top, key); return; }
  S.maybe = { top, key };
  $("guide").classList.toggle("hit", clear);
  setStatus(`${clear ? "" : "Maybe "}${c1.name}?`, false, true, false, { label: "That's it", fn: acceptMaybe });
}
// Take the current best guess without waiting for the match to settle (also: tap the camera view).
function acceptMaybe(){ const M = S.maybe; if (!M) return; S.maybe = null; lock(M.top, M.key); }

/* ---------- found a card ---------- */
function lock(top, key){
  const d1 = top[0][1], best = R(top[0][0]);
  // alternatives worth showing: same Pokémon/trainer (reprints), or nearly as close
  // reprints of the same card in other sets (same name, similar art), then anything nearly as close
  const others = top.slice(1).filter(([i, d]) => (R(i).name === best.name && d < Math.max(d1 * 2.5, 40000)) || d < d1 * 1.35).slice(0, 15).map(([i]) => i);
  let ids = [top[0][0], ...others];
  // English and Japanese printings (and reprints) can share identical art: on a near-tie, put your usual language first
  const near = ids.filter(i => R(i).name === best.name && top.find(t => t[0]===i)[1] <= d1 * 1.2);
  const fav = near.find(i => R(i).lang === S.prefer);
  if (fav != null && R(ids[0]).lang !== S.prefer) ids = [fav, ...ids.filter(i => i !== fav)];
  // also offer the other language versions of Japanese matches (same art: Japanese, Chinese, Korean)
  // (for the best match always; for the rest only the language you're scanning, so the row stays short)
  // Mixed: every reprint first, then every language version of them tacked on at the end
  const opts = [], tail = [], mixed = S.prefer === "mix";
  for (const [k, id] of ids.entries()){
    opts.push(id);
    const c = R(id); if (S.rows[id][0] !== "ja") continue;
    for (const l of ["ja", "zh", "ko"]) if (l !== c.lang && (l === "ja" || S.twins[id]?.[l])){
      if (mixed) tail.push(id + ":" + l); else if (k === 0 || l === S.prefer) opts.push(id + ":" + l);
    }
  }
  ids = mixed ? opts.concat(tail).slice(0, 40) : opts.slice(0, 24);
  S.locked = { key, ids };
  S.pick = 0; S.qty = 1; S.print = firstPrint(R(ids[0])); S.history = [];
  buzz();
  if (S.auto && !others.length){ addLocked(); return; }
  renderFound();
}
function renderFound(){
  const L = S.locked; if (!L){ $("found").hidden = true; return; }
  const c = R(L.ids[S.pick]);
  $("fImg").src = imgUrl(c); $("fImg").alt = c.name;
  $("fName").textContent = c.name;
  $("fAlt").textContent = c.orig || "";
  $("fMeta").textContent = `${c.code} ${c.num}${c.off ? "/"+String(c.off).padStart(3,"0") : ""} · ${c.setName}${c.rarity ? " · "+c.rarity : ""}${TAG[c.lang] ? " · "+TAG[c.lang] : ""}`;
  $("othersWrap").hidden = L.ids.length < 2;
  $("others").innerHTML = L.ids.map((id, k) => { const o = R(id);
    return `<button data-k="${k}" aria-pressed="${k===S.pick}"><img src="${esc(imgUrl(o))}" alt="" loading="lazy">${esc(o.code)} ${esc(o.num)}${TAG[o.lang] ? " "+TAG[o.lang] : ""}</button>`; }).join("");
  const LP = listedPrints(c), X = extraFinishes(LP);
  if (![...LP, ...X].includes(S.print)) S.print = firstPrint(c);
  const btn = (p, k, x) => `<button data-p="${esc(p)}" class="${x ? "x" : ""}" aria-pressed="${p===S.print}"><b>${k+1}</b>${esc(finishLabel(p))}</button>`;
  $("prints").innerHTML = LP.map((p, k) => btn(p, k, false)).join("") + (X.length ? `<span class="xlbl">${LP.length ? "Not in the card data" : "Finish"}</span>` + X.map((p, k) => btn(p, LP.length + k, true)).join("") : "");
  $("qN").textContent = S.qty; $("addBtn").textContent = S.qty > 1 ? `Add ×${S.qty}` : "Add";
  $("found").hidden = false; $("tips").hidden = true; renderOther();
  setStatus("Found it. Check the card and print, then Add.");
}
// A second tap on the option that's already picked (or two quick taps) adds the card.
let lastTap = { what: "", t: 0 };
function tapTwice(what){ const now = Date.now(), again = lastTap.what === what && now - lastTap.t < 600; lastTap = { what, t: now }; return again; }
$("others").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return; const k = +b.dataset.k;
  const again = tapTwice("c" + k);
  if (k !== S.pick){ S.pick = k; S.print = firstPrint(R(S.locked.ids[S.pick])); renderFound(); }
  if (again) addLocked();
});
$("prints").addEventListener("click", e => {
  const b = e.target.closest("button[data-p]"); if (!b) return;
  const again = tapTwice("p" + b.dataset.p);
  S.print = b.dataset.p; renderFound();
  if (again) addLocked();
});
$("fImg").addEventListener("click", () => { if (tapTwice("img")) addLocked(); });
$("qMinus").addEventListener("click", () => { S.qty = Math.max(1, S.qty-1); renderFound(); });
$("qPlus").addEventListener("click", () => { S.qty++; renderFound(); });
$("addBtn").addEventListener("click", addLocked);
$("skipBtn").addEventListener("click", () => resume());
$("cam").addEventListener("click", e => {
  if (e.target.closest(".camtools, .zoom, .start")) return;
  if (S.locked) resume(); else if (S.maybe) acceptMaybe();
});

/* ---------- "Part of another set": log the recognized card under the set printed on yours ---------- */
// Simplified Chinese products (Gem Packs CBB…, CSV…, CS…) aren't in the card data; their codes start with C.
const otherLang = (set, c) => /^C(BB|SV|S|SM)/i.test(set) ? "cn" : c.lang;
function renderOther(){
  if ($("otherBox").hidden || !S.locked) return;
  const c = R(S.locked.ids[S.pick]), set = $("otherSet").value.trim().toUpperCase();
  $("otherLang").textContent = `${c.name} · ${finishLabel(S.print)} · ${({en:"English",ja:"Japanese",zh:"Chinese (Taiwan/HK)",ko:"Korean",cn:"Chinese (mainland)"})[otherLang(set, c)]}`;
}
$("otherBtn").addEventListener("click", () => {
  const box = $("otherBox"); box.hidden = !box.hidden;
  if (!box.hidden){ $("otherSet").value = store.get("otherSet", ""); $("otherNum").value = ""; renderOther(); ($("otherSet").value ? $("otherNum") : $("otherSet")).focus(); }
});
$("otherSet").addEventListener("input", renderOther);
function addOther(){
  const L = S.locked; if (!L) return;
  const c = R(L.ids[S.pick]), finish = S.print || firstPrint(c);
  const set = $("otherSet").value.trim().toUpperCase().replace(/[|\s]+/g, "") || "OTHER";
  const num = $("otherNum").value.trim().replace(/[|\s]+/g, "") || "?";
  const lang = otherLang(set, c); store.set("otherSet", set === "OTHER" ? "" : set);
  const k = `${lang}|~${set}|${num}|${finish}|${c.name}`;
  const it = S.batch[k] || {lang, setId:"~"+set, setName:"Other set", code:set, num, name:c.name, img:c.img, finish, qty:0, other:true};
  it.qty += S.qty; it.t = Date.now(); S.batch[k] = it; saveBatch();
  S.lastAdded = {key: L.key, t: Date.now(), batchKey: k, qty: S.qty, name: c.name};
  toast(`+${S.qty} ${c.name} (${set} ${num})`);
  resume(true);
}
$("otherAdd").addEventListener("click", addOther);
$("otherNum").addEventListener("keydown", e => { if (e.key === "Enter") addOther(); });

function addLocked(){
  const L = S.locked; if (!L) return;
  const c = R(L.ids[S.pick]), finish = S.print || firstPrint(c);
  const k = `${c.lang}|${c.setId}|${c.num}|${finish}`;
  const it = S.batch[k] || {lang:c.lang, setId:c.setId, setName:c.setName, code:c.code, num:c.num, name:c.name, img:c.img, finish, qty:0};
  it.qty += S.qty; it.t = Date.now(); S.batch[k] = it; saveBatch();
  S.lastAdded = {key: L.key, t: Date.now(), batchKey: k, qty: S.qty, name: c.name};
  toast(`+${S.qty} ${c.name}`);
  resume(true);
}
function undoLast(){
  const A = S.lastAdded; if (!A) return;
  const it = S.batch[A.batchKey];
  if (it){ it.qty -= A.qty; if (it.qty <= 0) delete S.batch[A.batchKey]; saveBatch(); }
  toast(`Removed ${A.name}`); S.lastAdded = null; setStatus("Looking for a card…", false, true);
}
function resume(added){
  S.locked = null; $("found").hidden = true; $("otherBox").hidden = true; $("tips").hidden = false; $("guide").classList.remove("hit"); S.history = [];
  if (added) setStatus(`Added ${S.lastAdded.name}.`, false, true, true); else setStatus("Looking for a card…", false, true);
  if (S.scanning) loop();
}

/* ---------- status, feedback ---------- */
let lastStatus = "";
function setStatus(msg, err, live, undo, action){
  // don't rebuild the line (and its button) every frame, or a tap can land on a button that just got replaced
  const sig = [msg, err, live, undo, action?.label].join("|"); if (sig === lastStatus) return; lastStatus = sig;
  $("status").innerHTML = "";
  const s = document.createElement("span"); s.textContent = msg; if (err) s.className = "err";
  $("status").append(s);
  if (action){ const b = document.createElement("button"); b.textContent = action.label; b.className = "accept"; b.onclick = action.fn; $("status").append(b); }
  if (undo){ const b = document.createElement("button"); b.textContent = "Undo"; b.style.cssText = "margin-left:auto;padding:4px 10px;border:1px solid var(--line);border-radius:7px;color:var(--fg)"; b.onclick = undoLast; $("status").append(b); }
  $("dot").classList.toggle("live", !!live);
}
let actx;
function buzz(){
  try { navigator.vibrate?.(60); } catch(e){}
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = 880; g.gain.value = 0.06; o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + 0.08);
  } catch(e){}
}
let tt; function toast(t){ const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(tt); tt = setTimeout(() => el.hidden = true, 1500); }
function esc(s){ return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
$("auto").checked = S.auto;
function renderPrefer(){ for (const b of document.querySelectorAll("#prefer button")) b.setAttribute("aria-pressed", String(b.dataset.l === S.prefer)); }
$("prefer").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; S.prefer = b.dataset.l; store.set("prefer", S.prefer); renderPrefer(); if (S.locked){ S.print = firstPrint(R(S.locked.ids[S.pick])); renderFound(); } });
renderPrefer();
$("auto").addEventListener("change", e => { S.auto = e.target.checked; store.set("auto", S.auto); });

/* ---------- batch ---------- */
function saveBatch(){ store.set("batch", S.batch); renderCount(); if (!$("sheet").hidden) renderBatch(); }
function renderCount(){ let n = 0; for (const it of Object.values(S.batch)) n += it.qty; $("bCount").textContent = n; return n; }
function renderBatch(){
  const items = Object.entries(S.batch).sort((a,b) => (b[1].t||0) - (a[1].t||0));
  const n = renderCount();
  $("sTotal").textContent = items.length ? `${n} cards · ${items.length} unique` : "";
  $("list").innerHTML = items.length ? items.map(([k,it]) => `<div class="item"><img src="${esc(imgOf(it.img))}" alt="" loading="lazy"><div style="min-width:0"><div class="nm">${esc(it.name)}</div><div class="meta">${esc(it.code)} ${esc(it.num)}${it.other ? " (other set)" : ""} · ${esc(finishLabel(it.finish))}${TAG[it.lang||"en"] ? " · "+TAG[it.lang] : ""}</div></div>
    <button data-k="${esc(k)}" data-d="-1" aria-label="One fewer">−</button><span class="ct">×${it.qty}</span><button data-k="${esc(k)}" data-d="1" aria-label="One more">+</button></div>`).join("")
    : `<div class="empty">Nothing scanned yet. Cards you add show up here until you copy them into Card Tally.</div>`;
  $("out").hidden = true;
}
$("list").addEventListener("click", e => {
  const b = e.target.closest("button[data-k]"); if (!b) return;
  const it = S.batch[b.dataset.k]; if (!it) return;
  it.qty += +b.dataset.d; if (it.qty <= 0) delete S.batch[b.dataset.k]; saveBatch();
});
function batchText(){
  const lines = ["CARDTALLY 1"];
  for (const it of Object.values(S.batch)) lines.push([it.lang || "en", it.setId, it.num, it.finish, it.qty, String(it.name).replace(/\|/g,"/")].join("|"));
  return lines.join("\n");
}
$("openBatch").addEventListener("click", () => { renderBatch(); $("sheet").hidden = false; });
$("closeBatch").addEventListener("click", () => { $("sheet").hidden = true; resetClear(); });
$("copyBtn").addEventListener("click", async () => {
  if (!Object.keys(S.batch).length){ toast("The batch is empty"); return; }
  const text = batchText();
  try { await navigator.clipboard.writeText(text); toast("Copied. Paste it into Card Tally's Import"); }
  catch(e){ const o = $("out"); o.value = text; o.hidden = false; o.focus(); o.select(); toast("Select all and copy this text"); }
});
function resetClear(){ $("clearRow").innerHTML = `<button id="clearBtn">Clear batch</button>`; }
$("clearRow").addEventListener("click", e => {
  if (e.target.id === "clearBtn"){ $("clearRow").innerHTML = `<span>Clear all ${renderCount()} cards from the batch?</span><button class="danger" id="clearYes">Clear</button><button id="clearNo">Keep</button>`; }
  else if (e.target.id === "clearYes"){ S.batch = {}; saveBatch(); renderBatch(); resetClear(); toast("Batch cleared"); }
  else if (e.target.id === "clearNo") resetClear();
});

/* ---------- boot ---------- */
/* ---------- optional card packs kept on this device (Simplified Chinese) ----------
   The pack file holds the card list, artwork fingerprints and thumbnails. It is loaded from a file you
   keep yourself and stored only in this browser; nothing in it is part of this site. */
function packDb(){ return new Promise((res, rej) => { const q = indexedDB.open("cardscanner-packs", 1);
  q.onupgradeneeded = () => q.result.createObjectStore("packs"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function packDo(mode, fn){ const db = await packDb(); return new Promise((res, rej) => { const tx = db.transaction("packs", mode); const r = fn(tx.objectStore("packs")); tx.oncomplete = () => res(r.result); tx.onerror = () => rej(tx.error); }); }
const packAll = () => packDo("readonly", s => s.getAll());
function parsePack(buf){
  const u8 = new Uint8Array(buf);
  if (new TextDecoder().decode(u8.subarray(0, 8)) !== "CTPACK01") throw new Error("not a pack");
  const hl = new DataView(buf).getUint32(8, true);
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + hl)));
  const fpAt = 12 + hl + ((4 - (12 + hl) % 4) % 4), fpLen = head.n * head.dims;
  if (head.dims !== CardMatch.DIMS || !head.part || fpAt + fpLen > buf.byteLength) throw new Error("bad pack");
  for (const r of head.rows) r[8] = [head.part, r[8][0], r[8][1]];
  return { head, buf, fp: new Int8Array(buf, fpAt, fpLen), imgAt: fpAt + fpLen };
}
// Rebuild the searchable list: the site's cards, then every pack part saved on this device.
function usePacks(bufs){
  for (const u of PACK.urls.values()) URL.revokeObjectURL(u); PACK.urls.clear();
  const parts = bufs.map(parsePack).sort((a, b) => a.head.part.localeCompare(b.head.part));
  PACK.parts = {}; PACK.n = 0; let rows = S.baseRows, len = S.baseFp.length;
  for (const P of parts){ PACK.parts[P.head.part] = P; PACK.n += P.head.n; rows = rows.concat(P.head.rows); len += P.fp.length; }
  const fp = new Int8Array(len); fp.set(S.baseFp, 0); let at = S.baseFp.length;
  for (const P of parts){ fp.set(P.fp, at); at += P.fp.length; }
  S.rows = rows; S.fp = fp;
}
function renderPack(msg){
  const names = Object.keys(PACK.parts), want = names[0] ? +names[0].split("-of-")[1] : 0;
  $("packInfo").textContent = msg || (PACK.n
    ? `Simplified Chinese pack: ${PACK.n.toLocaleString()} cards on this device${names.length < want ? ` (${names.length} of ${want} files: load the rest)` : ""}.`
    : "Simplified Chinese (mainland) cards: load the pack files to recognize them.");
  $("packClear").hidden = !PACK.n;
}
$("packFile").addEventListener("change", async e => {
  const files = [...e.target.files]; e.target.value = ""; if (!files.length) return;
  renderPack("Reading the pack…");
  try {
    for (const f of files){
      const buf = await f.arrayBuffer(), P = parsePack(buf);
      await packDo("readwrite", s => s.put(buf, P.head.part));
    }
    usePacks(await packAll()); try { await navigator.storage?.persist?.(); } catch(e){}
    renderPack(); toast(`${PACK.n.toLocaleString()} Chinese cards ready`);
  } catch(err){ renderPack(err?.name === "QuotaExceededError" ? "This browser ran out of storage for the pack." : "Pick the scanner-pack-cn files (.cardpack)."); }
});
$("packClear").addEventListener("click", async () => {
  try { await packDo("readwrite", s => s.clear()); } catch(e){}
  usePacks([]); renderPack(); toast("Chinese pack removed");
});

renderCount(); loadData();
// test hook: lets an automated check match a still image without a camera
window.__scanTest = { R, listedPrints, match: canvas => CardMatch.search(S.fp, [CardMatch.fingerprint(canvas)], 5) };
})();
