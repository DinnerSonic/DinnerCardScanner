(() => {
const $ = id => document.getElementById(id);
const VLABEL = {normal:"Non-holo", holo:"Holo", reverse:"Reverse", pokeball:"Poké Ball / Patterned", masterball:"Alt Ball / Alt Pattern", unset:"Finish not set"};
const ALWAYS_HOLO = ["30C"];
const GUIDE_SIZES = [10, 13, 17, 22];
const LOCK_HITS = 2;          // same reading this many times in a row before it counts
const SAME_CARD_COOLDOWN = 2500; // ms before the card you just added can lock again

const store = {
  get(k, d){ try { const v = localStorage.getItem("scan:"+k); return v == null ? d : JSON.parse(v); } catch(e){ return d; } },
  set(k, v){ try { localStorage.setItem("scan:"+k, JSON.stringify(v)); } catch(e){} }
};

const S = {
  index: null, codes: null, worker: null, stream: null, track: null,
  scanning: false, busy: false, frame: 0, history: [], locked: null, qty: 1, pick: 0,
  variant: store.get("variant", "default"), auto: store.get("auto", false),
  batch: store.get("batch", {}), lastAdded: null, guide: store.get("guide", 1), debug: false, wake: null
};

/* ---------- finish defaults (same rules as the tally app) ---------- */
function knownFinishes(card){
  const set = new Set();
  for (const v of card.variants || []){
    if (/^[a-z]+:pokeball/.test(v) || v.startsWith("pokeball")) set.add("pokeball");
    else if (/masterball/.test(v)) set.add("masterball");
    else { const b = v.split(/[:+]/)[0]; set.add(["normal","holo","reverse"].includes(b) ? b : "other"); }
  }
  return [...set];
}
function resolveFinish(card){
  if (S.variant !== "default") return S.variant;
  if (ALWAYS_HOLO.includes(card.code)) return "holo";
  const k = knownFinishes(card);
  if (k.includes("normal")) return "normal";
  if (k.includes("holo")) return "holo";
  return k.find(x => x !== "other") || "unset";
}

/* ---------- camera ---------- */
async function startCamera(){
  $("startErr").hidden = true;
  if (!navigator.mediaDevices?.getUserMedia){ return fail("This browser can't use the camera. Open the page in Chrome over https."); }
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ audio:false, video:{ facingMode:{ideal:"environment"}, width:{ideal:1920}, height:{ideal:1080} } });
  } catch(e){
    return fail(e.name === "NotAllowedError" ? "Camera permission was blocked. Allow it in the browser's site settings, then try again." : "Couldn't start the camera ("+(e.name||"error")+").");
  }
  const v = $("video"); v.srcObject = S.stream; await v.play().catch(()=>{});
  S.track = S.stream.getVideoTracks()[0];
  setupTrackControls();
  $("start").hidden = true;
  try { S.wake = await navigator.wakeLock?.request("screen"); } catch(e){}
  setStatus("Loading the text reader…");
  if (!S.worker){
    try {
      S.worker = await Tesseract.createWorker("eng", 1, { workerPath: new URL("vendor/worker.min.js", location.href).href, corePath: new URL("vendor/core/", location.href).href, langPath: new URL("vendor/lang", location.href).href, workerBlobURL: false });
      await S.worker.setParameters({ tessedit_char_whitelist:"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/ ", tessedit_pageseg_mode:"7", preserve_interword_spaces:"1" });
    } catch(e){ setStatus("Couldn't load the text reader. Check your connection and reload.", true); return; }
  }
  S.scanning = true; setStatus("Looking for the card code…", false, true);
  loop();
}
function fail(msg){ $("startErr").textContent = msg; $("startErr").hidden = false; }
function setupTrackControls(){
  const caps = S.track.getCapabilities ? S.track.getCapabilities() : {};
  if (caps.focusMode?.includes("continuous")) S.track.applyConstraints({advanced:[{focusMode:"continuous"}]}).catch(()=>{});
  if (caps.torch) $("torch").hidden = false;
  if (caps.zoom && caps.zoom.max > caps.zoom.min){
    const z = $("zoom"); z.min = caps.zoom.min; z.max = caps.zoom.max; z.step = caps.zoom.step || 0.1;
    const want = Math.min(caps.zoom.max, Math.max(caps.zoom.min, store.get("zoom", Math.min(2, caps.zoom.max))));
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
  if (document.visibilityState === "visible" && S.stream && (!S.wake || S.wake.released)) { try { S.wake = await navigator.wakeLock?.request("screen"); } catch(e){} }
  if (document.visibilityState === "visible" && S.scanning) loop();
});

/* ---------- guide box ---------- */
function applyGuide(){ $("guide").style.setProperty("--gh", GUIDE_SIZES[S.guide] + "%"); }
$("guideSize").addEventListener("click", () => { S.guide = (S.guide + 1) % GUIDE_SIZES.length; store.set("guide", S.guide); applyGuide(); });
$("debug").addEventListener("click", () => { S.debug = !S.debug; $("debug").setAttribute("aria-pressed", String(S.debug)); $("ocrview").hidden = !S.debug; $("raw").hidden = !S.debug; });
applyGuide();

/* ---------- frame grab + clean-up for the reader ---------- */
const work = document.createElement("canvas");
function grabCrop(){
  const v = $("video"), cam = $("cam"), g = $("guide");
  const vw = v.videoWidth, vh = v.videoHeight; if (!vw) return null;
  const cr = cam.getBoundingClientRect(), gr = g.getBoundingClientRect();
  const scale = Math.max(cr.width / vw, cr.height / vh);
  const ox = (cr.width - vw*scale)/2, oy = (cr.height - vh*scale)/2;
  const sx = (gr.left - cr.left - ox)/scale, sy = (gr.top - cr.top - oy)/scale, sw = gr.width/scale, sh = gr.height/scale;
  // scale the strip so text is a comfortable size for the reader
  const outH = 90, k = outH / sh, outW = Math.round(sw * k), pad = 16;
  work.width = outW + pad*2; work.height = outH + pad*2;
  const ctx = work.getContext("2d", {willReadFrequently:true});
  ctx.fillStyle = "#fff"; ctx.fillRect(0,0,work.width,work.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(v, sx, sy, sw, sh, pad, pad, outW, outH);
  const img = ctx.getImageData(pad, pad, outW, outH), d = img.data, n = outW*outH;
  const gray = new Uint8Array(n); const hist = new Uint32Array(256);
  for (let i=0, j=0; i<n; i++, j+=4){ const y = (d[j]*299 + d[j+1]*587 + d[j+2]*114)/1000 | 0; gray[i]=y; hist[y]++; }
  // Otsu threshold
  let sum=0; for (let t=0;t<256;t++) sum += t*hist[t];
  let sB=0, wB=0, best=0, thr=127;
  for (let t=0;t<256;t++){ wB+=hist[t]; if(!wB) continue; const wF=n-wB; if(!wF) break; sB+=t*hist[t]; const mB=sB/wB, mF=(sum-sB)/wF, between=wB*wF*(mB-mF)*(mB-mF); if(between>best){best=between;thr=t;} }
  let dark=0; for (let i=0;i<n;i++) if (gray[i] < thr) dark++;
  const invert = dark > n/2;          // light text on a dark card: flip so text is dark
  const binarize = S.frame % 2 === 0; // alternate hard black/white with a softer contrast stretch
  let lo=255, hi=0; if (!binarize){ for (let i=0;i<n;i++){ if(gray[i]<lo)lo=gray[i]; if(gray[i]>hi)hi=gray[i]; } }
  const span = Math.max(1, hi-lo);
  for (let i=0, j=0; i<n; i++, j+=4){
    let y = binarize ? (gray[i] < thr ? 0 : 255) : ((gray[i]-lo)*255/span)|0;
    if (invert) y = 255 - y;
    d[j]=d[j+1]=d[j+2]=y;
  }
  ctx.putImageData(img, pad, pad);
  if (S.debug){ const o = $("ocrview"); o.width = work.width; o.height = work.height; o.getContext("2d").drawImage(work,0,0); }
  return work;
}

/* ---------- reading loop ---------- */
async function loop(){
  if (S.busy) return; S.busy = true;
  try {
    while (S.scanning && !S.locked && document.visibilityState === "visible"){
      if (!S.codes){ await sleep(200); continue; }
      const c = grabCrop(); S.frame++;
      if (!c){ await sleep(150); continue; }
      const { data } = await S.worker.recognize(c);
      if (S.locked || !S.scanning) break;
      handleRead(data.text || "");
    }
  } catch(e){ setStatus("The text reader hit an error. Reload the page to restart it.", true); }
  S.busy = false;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function handleRead(text){
  if (S.debug) $("raw").textContent = text.trim() || "(nothing)";
  const read = CardParse.parseLine(text, S.codes);
  let key = null, matches = [];
  if (read){ matches = CardParse.lookup(read, S.index); key = matches.length ? read.code+"|"+read.num.replace(/^0+(?=\d)/,"") : "x"; }
  S.history.push(key); if (S.history.length > 4) S.history.shift();
  if (!read){ $("guide").classList.remove("hit"); setStatus("Looking for the card code…", false, true); return; }
  if (!matches.length){ setStatus(`Read ${read.code} ${read.num}, but no such card. Adjust and hold still.`, false, true); return; }
  $("guide").classList.add("hit");
  const run = S.history.slice(-LOCK_HITS);
  const stable = run.length === LOCK_HITS && run.every(k => k === key);
  const recent = S.lastAdded && S.lastAdded.key === key && Date.now() - S.lastAdded.t < SAME_CARD_COOLDOWN;
  if (recent){ setStatus(`Just added ${matches[0].name}. Move to the next card.`, false, true); return; }
  if (!stable){ setStatus(`Reading ${read.code} ${read.num}… hold still`, false, true); return; }
  lock(read, matches, key);
}

/* ---------- found a card ---------- */
function lock(read, matches, key){
  S.locked = {read, matches: matches.map(m => ({...m, code: read.code})), key};
  S.qty = 1; S.pick = 0; S.history = [];
  buzz();
  if (S.auto && matches.length === 1){ addLocked(); return; }
  renderFound();
}
function renderFound(){
  const L = S.locked; if (!L){ $("found").hidden = true; return; }
  const c = L.matches[S.pick];
  $("fName").textContent = c.name;
  $("fMeta").textContent = `${c.code} ${c.num}${c.set.off ? "/"+String(c.set.off).padStart(3,"0") : ""} · ${c.set.name}${c.rarity ? " · "+c.rarity : ""} · ${VLABEL[resolveFinish(c)]}`;
  const alts = $("fAlts");
  if (L.matches.length > 1){
    alts.innerHTML = L.matches.map((m,i) => `<button data-i="${i}" aria-pressed="${i===S.pick}">${esc(m.name)} · ${esc(m.set.name)}</button>`).join("");
    alts.hidden = false;
  } else alts.hidden = true;
  $("qN").textContent = S.qty;
  $("addBtn").textContent = S.qty > 1 ? `Add ×${S.qty}` : "Add";
  $("found").hidden = false;
  setStatus("Found it. Check the name, then Add.");
}
$("fAlts").addEventListener("click", e => { const b = e.target.closest("button"); if (b){ S.pick = +b.dataset.i; renderFound(); } });
$("qMinus").addEventListener("click", () => { S.qty = Math.max(1, S.qty-1); renderFound(); });
$("qPlus").addEventListener("click", () => { S.qty++; renderFound(); });
$("addBtn").addEventListener("click", addLocked);
$("skipBtn").addEventListener("click", () => resume());
$("cam").addEventListener("click", e => { if (S.locked && !e.target.closest(".camtools, .zoom")) resume(); });

function addLocked(){
  const L = S.locked; if (!L) return;
  const c = L.matches[S.pick], finish = resolveFinish(c);
  const k = `${c.set.id}|${c.num}|${finish}`;
  const it = S.batch[k] || {setId:c.set.id, setName:c.set.name, code:c.code, num:c.num, name:c.name, finish, qty:0};
  it.qty += S.qty; it.t = Date.now(); S.batch[k] = it; saveBatch();
  S.lastAdded = {key: L.key, t: Date.now(), batchKey: k, qty: S.qty, name: c.name};
  toast(`+${S.qty} ${c.name}`);
  resume(true);
}
function undoLast(){
  const A = S.lastAdded; if (!A) return;
  const it = S.batch[A.batchKey];
  if (it){ it.qty -= A.qty; if (it.qty <= 0) delete S.batch[A.batchKey]; saveBatch(); }
  toast(`Removed ${A.name}`); S.lastAdded = null; setStatus("Looking for the card code…", false, true);
}
function resume(added){
  S.locked = null; $("found").hidden = true; $("guide").classList.remove("hit"); S.history = [];
  if (added) setStatus(`Added ${S.lastAdded.name}.`, false, true, true);
  else setStatus("Looking for the card code…", false, true);
  if (S.scanning) loop();
}

/* ---------- status, feedback ---------- */
function setStatus(msg, err, live, undo){
  $("status").innerHTML = "";
  const s = document.createElement("span"); s.textContent = msg; if (err) s.className = "err";
  $("status").append(s);
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

/* ---------- finish + auto ---------- */
function renderChips(){ for (const c of $("chips").children) c.setAttribute("aria-pressed", String(c.dataset.v === S.variant)); }
$("chips").addEventListener("click", e => { const c = e.target.closest(".chip"); if (!c) return; S.variant = c.dataset.v; store.set("variant", S.variant); renderChips(); if (S.locked) renderFound(); });
$("auto").checked = S.auto;
$("auto").addEventListener("change", e => { S.auto = e.target.checked; store.set("auto", S.auto); });
renderChips();

/* ---------- batch ---------- */
function saveBatch(){ store.set("batch", S.batch); renderCount(); if (!$("sheet").hidden) renderBatch(); }
function renderCount(){ let n = 0; for (const it of Object.values(S.batch)) n += it.qty; $("bCount").textContent = n; return n; }
function renderBatch(){
  const items = Object.entries(S.batch).sort((a,b) => (b[1].t||0) - (a[1].t||0));
  const n = renderCount();
  $("sTotal").textContent = items.length ? `${n} cards · ${items.length} unique` : "";
  $("list").innerHTML = items.length ? items.map(([k,it]) => `<div class="item"><div style="min-width:0"><div class="nm">${esc(it.name)}</div><div class="meta">${esc(it.code)} ${esc(it.num)} · ${esc(VLABEL[it.finish]||it.finish)}</div></div>
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
  for (const it of Object.values(S.batch)) lines.push(["en", it.setId, it.num, it.finish, it.qty, it.name.replace(/\|/g,"/")].join("|"));
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
renderCount();
fetch("cards-en.json").then(r => r.json()).then(j => { S.index = j; S.codes = new Set(Object.keys(j.codes)); })
  .catch(() => fail("Couldn't load the card list. Check your connection and reload."));
})();
