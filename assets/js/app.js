/* ============================================================
   CHEQ - ban wave watch
   Pulls three kinds of data and turns them into one score:
     · r/robloxhackers posts (proxy -> arctic shift -> public proxies)
     · WEAO registry (executor flags + client deploys)
     · the wave ledger (documented sweeps + spikes we spot)
   ============================================================ */
"use strict";

const CFG = {
  REFRESH_MS: 5 * 60 * 1000,
  FETCH_TIMEOUT: 12000,
  SUB: "robloxhackers",
  WEAO_UA: { "User-Agent": "WEAO-3PService" },
  // strong = clearly about a wave, weak = ban-adjacent noise we still count
  STRONG_RE: /\b(ban\s?wave|banwave|wave (is )?(over|back|start|incoming|hitting|here)|mass(ly)? (ban|terminat)|terminated|termination|account (got )?(deleted|termed)|perma(nently)? banned|ip banned|hwid ban)\b/i,
  WEAK_RE: /\b(ban|banned|banning|suspend|suspension|detect|detected|detection|hyperion|byfron|appeal|unban|moderat|flagged|terminated|deleted account)\b/i,
  NOISE_RE: /\b(adblock|ad block|anti-?virus|antivirus|work\.?ink|key system|linkvertise|firewall|windows defender|virustotal)\b/i,
  WINDOW_H: 168,
  SPIKE_H: 24,
  HALF_LIFE_H: 20,
  STRONG_W: 2.0,
  WEAK_W: 0.6,
  COMM_SAT: 18,
  W: { community: 40, detection: 25, patch: 15, deploy: 10, cadence: 10 },
  CADENCE_MEAN_D: 90,
  CADENCE_RAMP_START: 75,
  CADENCE_RAMP_LEN: 20,
  BANDS: [
    { min: 0,  key: "clear", label: "CLEAR",       css: "s-clear", color: "#34d399",
      note: "Nothing out of the ordinary. Chatter, detection flags and deploy timing all look normal." },
    { min: 25, key: "elev",  label: "ELEVATED",    css: "s-elev",  color: "#fbbf24",
      note: "A few warning signs are on. Standard advice for windows like this: assume anything you run could be getting logged, and give it a day or two after things quiet down." },
    { min: 50, key: "high",  label: "HIGH RISK",   css: "s-high",  color: "#fb923c",
      note: "Several signals at once, which is what the run-up to past sweeps looked like. Don't run anything on an account you care about." },
    { min: 75, key: "wave",  label: "WAVE LIKELY", css: "s-wave",  color: "#ef4444",
      note: "This is what an active wave tends to look like from the outside. Stay off executors completely until the chatter goes quiet for a couple of days." },
  ],
  // the ledger is rebuilt from live archive data, nothing is hand-written
  LEDGER_QUERIES: ["ban", "terminated"],
  LEDGER_MAX_PAGES: 8,        // per query; ~6-12 months of this sub's history
  LEDGER_PAGE_GAP_MS: 1000,   // archive rate limits are touchy, go slow
  LEDGER_TTL_MS: 12 * 3600e3,
  LEDGER_EMPTY_TTL_MS: 4 * 60e3, // thin/blocked scans retry quickly instead
  SPIKE_MIN: 5,               // a spike day needs at least this many matches
  SPIKE_MULT: 2.5,            // ...and at least this much over the daily median
  WAVE_GAP_D: 3,              // spike days this close together merge into one wave
};

/* ---------------- utils ---------------- */
const $ = (id) => document.getElementById(id);
const now = () => Date.now();
const hoursAgo = (epochSec) => (now() - epochSec * 1000) / 36e5;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const store = {
  get(k, d) { try { const v = localStorage.getItem("cheq." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("cheq." + k, JSON.stringify(v)); } catch {} },
};

function fetchJSON(url, { timeout = CFG.FETCH_TIMEOUT, headers = {} } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  return fetch(url, { signal: ctl.signal, headers })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .finally(() => clearTimeout(t));
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function ageStr(epochSec) {
  const h = hoursAgo(epochSec);
  if (h < 1) return Math.max(1, Math.round(h * 60)) + "m ago";
  if (h < 24) return Math.round(h) + "h ago";
  return Math.round(h / 24) + "d ago";
}

function relStr(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  return Math.floor(m / 60) + "h ago";
}

function parseLooseDate(s) {
  // WEAO hands us things like "11/17/2026, 5:00:15 PM UTC"
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4}).*?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!m) return null;
  let [, mo, d, y, hh, mm, ss, ap] = m;
  let H = +hh % 12 + (ap && ap.toUpperCase() === "PM" ? 12 : 0);
  if (!ap) H = +hh;
  return Date.UTC(+y, +mo - 1, +d, H, +mm, +(ss || 0));
}

let toastTimer = null;
function toast(msg, kind = "") {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast show" + (kind ? " " + kind : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

/* ---------------- source health ---------------- */
const health = { community: "down", weao: "down", ledger: "ok", communityVia: "none" };
function setHealth(k, v) { health[k] = v; renderHealth(); }
function renderHealth() {
  const strip = $("sourcesStrip");
  if (!strip) return;
  const label = { ok: "LIVE", deg: "STALE", down: "DOWN" };
  const via = health.communityVia !== "none" ? ` via ${health.communityVia}` : "";
  strip.innerHTML = [
    ["community", `community feed${via}`],
    ["weao", "weao registry"],
    ["ledger", "wave ledger"],
  ].map(([k, n]) => `<span class="src ${health[k]}"><span class="s-dot"></span>${esc(n)} · ${label[health[k]]}</span>`).join("");
  for (const [id, key] of [["srcCommunity", "community"], ["srcWeao", "weao"], ["srcLedger", "ledger"]]) {
    const el = $(id);
    el.className = "src-status " + health[key];
    el.textContent = "●";
  }
}

/* ---------------- post classification ---------------- */
function classifyPost(p) {
  const title = p.title || "";
  const body = p.selftext || "";
  if (CFG.NOISE_RE.test(title) && !CFG.STRONG_RE.test(title)) return null;
  if (CFG.STRONG_RE.test(title) || CFG.STRONG_RE.test(body)) return "strong";
  if (CFG.WEAK_RE.test(title) || CFG.WEAK_RE.test(body)) return "weak";
  return null;
}

/* ---------------- community fetching ---------------- */
function normalizePosts(payload, source) {
  let raw = [];
  if (source === "api" || source === "arctic") raw = payload.posts || payload.data || [];
  else if (source === "reddit") raw = (payload?.data?.children || []).map((c) => c.data);
  const seen = new Set();
  return raw
    .map((p) => ({
      id: p.id || p.name || p.permalink || (p.title || "") + p.created_utc,
      title: p.title || "",
      selftext: (p.selftext || "").slice(0, 1200),
      score: p.score ?? 0,
      comments: p.num_comments ?? 0,
      created: p.created_utc ?? (p.created ? p.created : null),
      permalink: p.permalink ? (String(p.permalink).startsWith("http") ? p.permalink : "https://www.reddit.com" + p.permalink) : null,
      flair: p.link_flair_text || null,
    }))
    .filter((p) => p.created && p.title && !seen.has(p.id) && seen.add(p.id))
    .sort((a, b) => b.created - a.created);
}

async function getCommunityPosts() {
  // the serverless proxy first, when it exists (deployed builds)
  try {
    const j = await fetchJSON("/api/reddit", { timeout: 9000 });
    const posts = normalizePosts(j, "api");
    if (posts.length) { health.communityVia = "/api/reddit"; return { posts, quality: "ok" }; }
  } catch {}

  // the arctic shift archive: open CORS, ingests close to real time
  try {
    const j = await fetchJSON(
      `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${CFG.SUB}&limit=100&sort=desc`
    );
    const posts = normalizePosts(j, "arctic");
    if (posts.length) { health.communityVia = "arctic shift"; return { posts, quality: "ok" }; }
  } catch {}

  // public proxies wrapping reddit's own json, flaky but better than nothing
  const target = `https://www.reddit.com/r/${CFG.SUB}/new.json?limit=100&raw_json=1`;
  const proxies = [
    (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
    (u) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u),
    (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
  ];
  for (const wrap of proxies) {
    try {
      const j = await fetchJSON(wrap(target), { timeout: 14000 });
      const posts = normalizePosts(j, "reddit");
      if (posts.length) { health.communityVia = "proxy"; return { posts, quality: "deg" }; }
    } catch {}
  }

  // last resort: whatever we cached earlier
  const cached = store.get("postsCache");
  if (cached?.posts?.length) { health.communityVia = "cache"; return { posts: cached.posts, quality: "deg" }; }
  return { posts: [], quality: "down" };
}

/* ---------------- WEAO fetching ---------------- */
async function getWeao() {
  const base = "https://weao.xyz/api";
  const wrap = (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u);
  const grab = async (path) => {
    try { return await fetchJSON(base + path, { headers: CFG.WEAO_UA }); }
    catch { return await fetchJSON(wrap(base + path), { timeout: 14000 }); }
  };
  const [exploits, current, future] = await Promise.all([
    grab("/status/exploits"),
    grab("/versions/current"),
    grab("/versions/future").catch(() => null),
  ]);
  return { exploits, current, future };
}

/* ---------------- scoring ---------------- */
function scoreCommunity(posts) {
  let raw = 0, strong24 = 0, matched24 = 0, matchedTotal = 0;
  const buckets = new Array(28).fill(0); // 6h buckets across the week
  for (const p of posts) {
    const cls = p.cls; if (!cls) continue;
    const h = hoursAgo(p.created);
    if (h > CFG.WINDOW_H) continue;
    matchedTotal++;
    const w = (cls === "strong" ? CFG.STRONG_W : CFG.WEAK_W)
      * Math.pow(1 + Math.max(0, p.score), 0.5)
      * Math.pow(0.5, h / CFG.HALF_LIFE_H);
    raw += w;
    const b = Math.floor(h / 6); if (b >= 0 && b < 28) buckets[b] += w;
    if (h <= CFG.SPIKE_H) { matched24++; if (cls === "strong") strong24++; }
  }
  const pts = CFG.W.community * (1 - Math.exp(-raw / CFG.COMM_SAT));
  return { pts, raw, strong24, matched24, matchedTotal, buckets };
}

function scoreExecutors(exploits) {
  const list = (exploits || []).filter((e) => e && e.title);
  const total = list.length || 1;
  const detected = list.filter((e) => e.detected).length;
  const pending = list.filter((e) => e.updateStatus === false).length;
  return {
    list, total, detected, pending,
    detPts: CFG.W.detection * Math.min(1, (detected / total) / 0.55),
    patchPts: CFG.W.patch * Math.min(1, (pending / total) / 0.7),
  };
}

function scoreDeploy(current, future) {
  let pts = 0;
  const winTs = parseLooseDate(current?.WindowsDate);
  const deployH = winTs ? (now() - winTs) / 36e5 : null;
  if (deployH !== null) pts += deployH < 30 ? 5 : deployH < 72 ? 2 : 0;
  const staged = future?.Windows && current?.Windows && future.Windows !== current.Windows;
  if (staged) pts += 3;
  return { pts: Math.min(CFG.W.deploy, pts), deployH, staged, winTs, current, future };
}

/* ---------------- ledger scan (data-driven wave history) ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function arcticSearch(extra, timeout = 20000) {
  const url = `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${CFG.SUB}&limit=100&sort=desc&${extra}`;
  for (let a = 0; a < 3; a++) {
    try { return await fetchJSON(url, { timeout }); }
    catch { if (a < 2) await sleep(1500 * (a + 1)); }
  }
  return null;
}

const dayKey = (epochSec) => new Date(epochSec * 1000).toISOString().slice(0, 10);

let scanning = false;
async function scanLedger(force = false) {
  const cached = store.get("ledgerScan");
  const ttl = cached?.solid ? CFG.LEDGER_TTL_MS : CFG.LEDGER_EMPTY_TTL_MS;
  if (!force && cached && now() - cached.at < ttl && Array.isArray(cached.waves)) {
    return cached;
  }
  if (scanning) return cached || null;
  scanning = true;
  setHealth("ledger", "deg");
  try {
    // deployed builds: the function does the paging and everyone shares it.
    // an empty scan never replaces a real one, and cold starts get one retry.
    for (let a = 0; a < 2; a++) {
      try {
        const j = await fetchJSON("/api/ledger", { timeout: 45000 });
        if (Array.isArray(j.waves)) {
          if (j.waves.length || !cached?.waves?.length) {
            store.set("ledgerScan", j);
            setHealth("ledger", "ok");
            return j;
          }
          setHealth("ledger", "ok");
          return cached;
        }
      } catch {
        if (!a) await sleep(2000);
      }
    }

    const byDay = {};
    // seed with the posts the live feed already pulled
    const seenIds = new Set();
    for (const p of livePosts) {
      if (!p.created) continue;
      seenIds.add(p.id || (p.title + p.created));
      if (p.cls) byDay[dayKey(p.created)] = (byDay[dayKey(p.created)] || 0) + 1;
    }
    let oldest = Infinity;
    for (const q of CFG.LEDGER_QUERIES) {
      let before = null;
      for (let page = 0; page < CFG.LEDGER_MAX_PAGES; page++) {
        const extra = `query=${encodeURIComponent(q)}&fields=title,created_utc,id` + (before ? `&before=${before}` : "");
        const j = await arcticSearch(extra);
        const rows = j?.data || [];
        if (!rows.length) break;
        for (const p of rows) {
          if (!p.created_utc) continue;
          const id = p.id || ((p.title || "") + p.created_utc);
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          byDay[dayKey(p.created_utc)] = (byDay[dayKey(p.created_utc)] || 0) + 1;
          if (p.created_utc < oldest) oldest = p.created_utc;
        }
        if (rows.length < 100) break;
        before = rows[rows.length - 1].created_utc - 1;
        await sleep(CFG.LEDGER_PAGE_GAP_MS);
      }
      await sleep(CFG.LEDGER_PAGE_GAP_MS);
    }
    if (seenIds.size <= livePosts.length) { // blocked out entirely, keep the old scan
      setHealth("ledger", cached ? "ok" : "deg");
      return cached || null;
    }
    const waves = wavesFromCounts(byDay);
    if (!waves.length && cached?.waves?.length) { // quiet scan over real data? keep the real one
      setHealth("ledger", "ok");
      return cached;
    }
    const coveredD = oldest === Infinity ? 0 : (now() - oldest * 1000) / 864e5;
    const solid = waves.length > 0 && coveredD >= 60; // thin scans shouldn't live 12h
    const scan = { at: now(), waves, coverFrom: oldest === Infinity ? null : dayKey(oldest), solid };
    store.set("ledgerScan", scan);
    setHealth("ledger", "ok");
    return scan;
  } finally {
    scanning = false;
  }
}

function wavesFromCounts(byDay) {
  const entries = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return [];
  const counts = entries.map(([, n]) => n).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] || 1;
  const floor = Math.max(CFG.SPIKE_MIN, median * CFG.SPIKE_MULT);
  const spikes = entries.filter(([, n]) => n >= floor).map(([d, n]) => ({ d, n }));
  if (!spikes.length) return [];

  const waves = [];
  let cur = { start: spikes[0].d, end: spikes[0].d, peak: spikes[0].d, peakN: spikes[0].n, total: spikes[0].n, days: 1 };
  for (let i = 1; i < spikes.length; i++) {
    const s = spikes[i];
    const gap = (new Date(s.d) - new Date(cur.end)) / 864e5;
    if (gap <= CFG.WAVE_GAP_D) {
      cur.end = s.d; cur.days++; cur.total += s.n;
      if (s.n > cur.peakN) { cur.peak = s.d; cur.peakN = s.n; }
    } else {
      waves.push(cur);
      cur = { start: s.d, end: s.d, peak: s.d, peakN: s.n, total: s.n, days: 1 };
    }
  }
  waves.push(cur);

  return waves.map((w) => {
    const mult = Math.round(w.peakN / Math.max(1, median));
    const range = w.start === w.end ? w.start : `${w.start} to ${w.end}`;
    return {
      date: w.start, end: w.end, peak: w.peak,
      name: w.days > 1 ? `Surge over ${w.days} days` : "One-day spike",
      desc: `${w.total} ban-talk posts hit the sub across ${range}, peaking at ${w.peakN} on ${w.peak} (about ${mult}x the usual ${median}/day).`,
      tag: "detected",
    };
  }).sort((a, b) => b.date.localeCompare(a.date));
}

function getLedger() {
  const scan = store.get("ledgerScan");
  const detected = scan?.waves || [];
  const extra = store.get("ledgerExtra", []).filter((w) =>
    !detected.some((d) => {
      const t = new Date(w.date).getTime();
      return t >= new Date(d.date).getTime() - 2 * 864e5 && t <= new Date(d.end || d.date).getTime() + 2 * 864e5;
    }));
  return [...detected, ...extra].sort((a, b) => new Date(b.date) - new Date(a.date));
}

function scoreCadence(ledger) {
  const last = ledger[0];
  if (!last) return { pts: 0, days: null, last: null };
  const days = (now() - new Date(last.date).getTime()) / 864e5;
  const pts = CFG.W.cadence * clamp((days - CFG.CADENCE_RAMP_START) / CFG.CADENCE_RAMP_LEN, 0, 1);
  return { pts, days, last };
}

function computeVerdict(total, commPts) {
  let forced = null;
  if (commPts >= 36) forced = "wave";
  else if (commPts >= 30) forced = "high";
  let band = CFG.BANDS[0];
  for (const b of CFG.BANDS) if (total >= b.min) band = b;
  if (forced) {
    const forcedBand = CFG.BANDS.find((b) => b.key === forced);
    if (forcedBand.min > band.min) band = forcedBand;
  }
  return band;
}

/* ---------------- rendering ---------------- */
function renderGauge(total, band) {
  const LEN = 283;
  const fill = $("gaugeFill");
  fill.style.strokeDashoffset = LEN * (1 - clamp(total, 0, 100) / 100);
  fill.style.setProperty("--gauge-glow", band.color + "66");
  $("riskScore").textContent = Math.round(total);
  const v = $("riskVerdict");
  v.textContent = band.label;
  v.style.setProperty("--verdict-c", band.color);
  const pill = $("statusPill");
  pill.className = "status-pill " + band.css;
  $("statusPillText").textContent = band.label;
  $("verdictNote").textContent = band.note;
  $("verdictCard").style.setProperty("--glow", band.color + "59");
}

function renderStats({ comm, execs, deploy }) {
  $("statPosts24h").textContent = comm.matched24;
  $("statPosts7d").textContent = `${comm.matchedTotal} matched in 7d, ${comm.strong24} of them alerts`;
  $("statDetected").textContent = execs.detected;
  $("statDetectedSub").textContent = `of ${execs.total} tracked executors`;
  $("statPending").textContent = execs.pending;
  $("statPendingSub").textContent = execs.pending ? "still rebuilding for this client" : "everything on the current build";
  $("statVersion").textContent = deploy.current?.Windows || "unknown";
  const h = deploy.deployH;
  $("statVersionSub").textContent = h === null
    ? "last deploy time unknown"
    : `windows deployed ${h < 24 ? Math.round(h) + "h" : Math.round(h / 24) + "d"} ago${deploy.staged ? ", next build staged" : ""}`;
  drawSpark($("sparkPosts"), comm.buckets);
}

function drawSpark(canvas, buckets) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth, hgt = 38;
  canvas.width = w * dpr; canvas.height = hgt * dpr;
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
  const data = buckets.slice().reverse();
  const max = Math.max(...data, 1);
  const bw = w / data.length;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#57d0ff";
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.75;
  data.forEach((v, i) => {
    const bh = Math.max(2, (v / max) * (hgt - 8));
    ctx.globalAlpha = 0.3 + 0.55 * (i / data.length);
    ctx.fillRect(i * bw + 1, hgt - bh, bw - 2, bh);
  });
  ctx.globalAlpha = 1;
}

function signalColor(frac) {
  if (frac >= 0.75) return "#ef4444";
  if (frac >= 0.5) return "#fb923c";
  if (frac >= 0.25) return "#fbbf24";
  return "#34d399";
}

function renderSignals({ comm, execs, deploy, cad }) {
  const defs = [
    { name: "Ban talk", pts: comm.pts, max: CFG.W.community,
      val: `${comm.matched24}<small> posts / 24h</small>`,
      desc: `${comm.strong24} alerts and ${comm.matched24 - comm.strong24} related posts in the last day. The sub usually hears it first.` },
    { name: "Detection flags", pts: execs.detPts, max: CFG.W.detection,
      val: `${Math.round((execs.detected / execs.total) * 100)}<small>% flagged</small>`,
      desc: `${execs.detected} of ${execs.total} tracked executors carry a live detection flag. A big pile means bans are being collected.` },
    { name: "Patch window", pts: execs.patchPts, max: CFG.W.patch,
      val: `${execs.pending}<small> updating</small>`,
      desc: `Executors still catching up to the current client. A wide-open window means the ground just moved.` },
    { name: "Deploy timing", pts: deploy.pts, max: CFG.W.deploy,
      val: deploy.deployH === null ? "?" : `${Math.round(deploy.deployH)}<small>h since deploy</small>`,
      desc: deploy.staged ? "The next client build is already staged, so new anti-cheat code could land any time." : "Sweeps like to ride the version bump. This tracks how fresh the last one is." },
    { name: "The rhythm", pts: cad.pts, max: CFG.W.cadence,
      val: `${Math.round(cad.days)}<small>d since last wave</small>`,
      desc: `Waves have tended to land every ~${CFG.CADENCE_MEAN_D} days. Past ${CFG.CADENCE_RAMP_START} days of quiet, this starts adding points.` },
  ];
  $("signalGrid").innerHTML = defs.map((d, i) => {
    const frac = d.pts / d.max, c = signalColor(frac);
    return `<div class="signal card fade-in" style="--sc:${c};animation-delay:${i * 60}ms">
      <div class="signal-name">${d.name}</div>
      <div class="signal-val">${d.val}</div>
      <div class="signal-desc">${d.desc}</div>
      <div class="signal-bar"><i style="width:${Math.round(frac * 100)}%"></i></div>
      <div class="signal-pts"><b>+${d.pts.toFixed(1)}</b> / ${d.max} pts</div>
    </div>`;
  }).join("");
}

let postFilter = store.get("postFilter", "all");
function renderFeed(posts) {
  const matched = posts.filter((p) => p.cls && hoursAgo(p.created) <= CFG.WINDOW_H);
  const shown = matched.filter((p) => postFilter === "all" || p.cls === postFilter).slice(0, 15);
  const list = $("postList");
  if (!shown.length) {
    list.innerHTML = `<li class="feed-empty card">Nothing matched in the last ${CFG.WINDOW_H / 24} days. A quiet feed is a signal of its own.</li>`;
  } else {
    list.innerHTML = shown.map((p) => `
      <li class="post fade-in">
        <span class="post-flag ${p.cls}">${p.cls === "strong" ? "ALERT" : "RELATED"}</span>
        <div class="post-main">
          <div class="post-title">${p.permalink ? `<a href="${esc(p.permalink)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}</div>
          <div class="post-meta">
            <span>${ageStr(p.created)}</span>
            <span class="post-score ${p.score > 0 ? "pos" : p.score < 0 ? "neg" : ""}">▲ ${p.score}</span>
            <span>${p.comments} replies</span>
            ${p.flair ? `<span>${esc(p.flair)}</span>` : ""}
          </div>
        </div>
      </li>`).join("");
  }
  const strong = matched.filter((p) => p.cls === "strong").length;
  $("feedFoot").textContent =
    `${matched.length} matched over ${CFG.WINDOW_H / 24}d, ${strong} alerts · via ${health.communityVia}`;
}

let execFilter = store.get("execFilter", "all");
let execSearch = "";
function execState(e) {
  if (e.detected) return "detected";
  if (e.updateStatus === false) return "pending";
  return "working";
}
function renderExecs(execs) {
  const q = execSearch.trim().toLowerCase();
  const rank = { detected: 0, pending: 1, working: 2 };
  const filtered = execs.list
    .filter((e) => execFilter === "all" || execState(e) === execFilter)
    .filter((e) => !q || (e.title || "").toLowerCase().includes(q))
    .sort((a, b) => rank[execState(a)] - rank[execState(b)] || (a.title || "").localeCompare(b.title));
  $("execBody").innerHTML = filtered.map((e) => {
    const st = execState(e);
    const badge = st === "detected" ? "DETECTED" : st === "pending" ? "UPDATING" : "WORKING";
    return `<div class="exec-row">
      <span class="exec-name">${esc(e.title)}<small>${esc(e.version || "")}${e.free === false ? " · paid" : e.free === true ? " · free" : ""}</small></span>
      <span class="exec-plat">${esc(e.platform || "?")}</span>
      <span><span class="exec-badge ${st}">${badge}</span></span>
    </div>`;
  }).join("") || `<div class="feed-empty">${q ? `Nothing matching "${esc(q)}".` : "No executors in this state."}</div>`;
}

function renderTimeline(ledger) {
  const scan = store.get("ledgerScan");
  if (!ledger.length) {
    if (scanning) {
      $("timeline").innerHTML = `<div class="feed-empty card" style="flex:1">Scanning the archive for ban-talk spikes, this takes a bit…</div>`;
    } else {
      const msg = scan
        ? "That scan came back quiet. If that looks wrong, the archive may have rate-limited us."
        : "Couldn't reach the archive for the ledger scan.";
      $("timeline").innerHTML = `<div class="feed-empty card" style="flex:1">${msg} <button class="retry-scan" id="scanRetry">retry the scan</button></div>`;
      $("scanRetry")?.addEventListener("click", () => {
        $("timeline").innerHTML = `<div class="feed-empty card" style="flex:1">Scanning the archive for ban-talk spikes, this takes a bit…</div>`;
        scanLedger(true).then(() => {
          if (liveModel) { liveModel.cad = scoreCadence(getLedger()); renderFromModel(); }
          renderTimeline(getLedger());
        });
      });
    }
    return;
  }
  $("timeline").innerHTML = ledger.map((w) => {
    const range = w.end && w.end !== w.date ? `${w.date} to ${w.end.slice(5)}` : w.date;
    return `<div class="tl-item">
      <div class="tl-date">${esc(range)}</div>
      <div class="tl-name">${esc(w.name)}</div>
      <div class="tl-desc">${esc(w.desc)}</div>
      <span class="tl-tag ${w.tag}">${w.tag.toUpperCase()}</span>
    </div>`;
  }).join("");
}

function renderMeta({ cad }) {
  if (!cad.last) {
    const scan = store.get("ledgerScan");
    $("metaLastWave").textContent = "Last wave: none on record";
    $("metaWindow").textContent = scanning
      ? "ledger scan running"
      : scan ? "no spike days in the record" : "ledger scan pending";
    return;
  }
  $("metaLastWave").textContent = `Last wave: ${cad.last.date} (${Math.round(cad.days)}d ago)`;
  const next = new Date(new Date(cad.last.date).getTime() + CFG.CADENCE_MEAN_D * 864e5);
  $("metaWindow").textContent = `~${CFG.CADENCE_MEAN_D}d rhythm puts the next window around ${next.toISOString().slice(0, 10)}`;
}

/* ---------------- wave recording ---------------- */
function maybeRecordWave(total, band, comm) {
  if (band.key !== "wave" && comm.pts < 36) return;
  const today = new Date().toISOString().slice(0, 10);
  const extra = store.get("ledgerExtra", []);
  const covered = getLedger().some((w) => {
    const t = new Date(today).getTime();
    return t >= new Date(w.date).getTime() - 2 * 864e5 && t <= new Date(w.end || w.date).getTime() + 2 * 864e5;
  });
  if (covered) return;
  extra.push({
    date: today, name: "Spotted by the engine",
    desc: `Score hit ${Math.round(total)} with ${comm.matched24} matched posts in a day, so we logged it as a probable wave.`,
    tag: "detected",
  });
  store.set("ledgerExtra", extra);
}

/* ---------------- gauge ticks ---------------- */
function buildGaugeTicks() {
  const g = $("gaugeTicks"); if (!g || g.childElementCount) return;
  let html = "";
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI - (Math.PI * i) / 10;
    const x1 = 110 + 97 * Math.cos(a), y1 = 110 - 97 * Math.sin(a);
    const x2 = 110 + 104 * Math.cos(a), y2 = 110 - 104 * Math.sin(a);
    html += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }
  g.innerHTML = html;
}

/* ---------------- shared state ---------------- */
let livePosts = [];
let liveExecs = null;
let liveModel = null;
let liveBand = null;
let liveTotal = 0;

function renderFromModel() {
  const { comm, execs, deploy, cad } = liveModel;
  const total = comm.pts + execs.detPts + execs.patchPts + deploy.pts + cad.pts;
  const band = computeVerdict(total, comm.pts);
  liveTotal = total;
  liveBand = band;
  maybeRecordWave(total, band, comm);
  renderGauge(total, band);
  renderStats(liveModel);
  renderSignals(liveModel);
  renderMeta(liveModel);
}

/* ---------------- main cycle ---------------- */
let busy = false;
async function refresh(manual = false) {
  if (busy) return;
  busy = true;
  const btn = $("refreshBtn");
  btn.classList.add("spinning");
  try {
    const [commRes, weaoRes] = await Promise.allSettled([getCommunityPosts(), getWeao()]);

    let posts = [];
    if (commRes.status === "fulfilled" && commRes.value.posts.length) {
      posts = commRes.value.posts;
      setHealth("community", commRes.value.quality);
      if (commRes.value.quality === "ok") store.set("postsCache", { posts });
    } else {
      setHealth("community", "down");
    }
    posts.forEach((p) => (p.cls = classifyPost(p)));
    livePosts = posts;

    let weao = null;
    if (weaoRes.status === "fulfilled") {
      weao = weaoRes.value;
      setHealth("weao", "ok");
      store.set("weaoCache", weao);
    } else if (store.get("weaoCache")) {
      weao = store.get("weaoCache");
      setHealth("weao", "deg");
    } else {
      setHealth("weao", "down");
    }

    const comm = scoreCommunity(posts);
    const execs = weao?.exploits?.length
      ? scoreExecutors(weao.exploits)
      : { list: [], total: 1, detected: 0, pending: 0, detPts: 0, patchPts: 0 };
    const deploy = weao?.current
      ? scoreDeploy(weao.current, weao.future)
      : { pts: 0, deployH: null, staged: false, current: null };
    const cad = scoreCadence(getLedger());

    liveModel = { comm, execs, deploy, cad };
    liveExecs = execs;
    renderFromModel();
    renderFeed(posts);
    renderExecs(execs);
    renderTimeline(getLedger());

    // rebuild the ledger from the archive in the background when stale
    const scan = store.get("ledgerScan");
    const scanTtl = scan?.solid ? CFG.LEDGER_TTL_MS : CFG.LEDGER_EMPTY_TTL_MS;
    if (!scan || now() - scan.at > scanTtl) {
      scanLedger().then(() => {
        if (!liveModel) return;
        liveModel.cad = scoreCadence(getLedger());
        renderFromModel();
        renderTimeline(getLedger());
      }).catch(() => renderTimeline(getLedger()));
    }
    if (manual) toast("Refreshed.");
  } catch (err) {
    console.error("[cheq] refresh failed:", err);
    if (manual) toast("Refresh failed, sources aren't answering.", "err");
  } finally {
    busy = false;
    btn.classList.remove("spinning");
    lastRefresh = now();
  }
}

/* ---------------- theme ---------------- */
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set("theme", t);
}
$("themeBtn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  setTheme(next);
  drawSpark($("sparkPosts"), liveModel ? liveModel.comm.buckets : new Array(28).fill(0));
});
matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", (e) => {
  if (!store.get("theme")) setTheme(e.matches ? "light" : "dark");
});

/* ---------------- copy status ---------------- */
$("copyStatus").addEventListener("click", async () => {
  if (!liveModel) return;
  const { comm, execs } = liveModel;
  const text = `cheq ban wave check: ${liveBand.label} (${Math.round(liveTotal)}/100) | ${comm.matched24} ban-talk posts/24h | ${execs.detected}/${execs.total} execs detected | updated ${new Date().toISOString().slice(11, 16)} utc`;
  try {
    await navigator.clipboard.writeText(text);
    $("copyStatusLabel").textContent = "copied!";
    $("copyStatus").classList.add("copied");
  } catch {
    $("copyStatusLabel").textContent = text.slice(0, 40) + "…";
  }
  setTimeout(() => {
    $("copyStatusLabel").textContent = "copy status";
    $("copyStatus").classList.remove("copied");
  }, 2200);
});

/* ---------------- filters ---------------- */
function syncFilterChips(containerSel, attr, value) {
  document.querySelectorAll(containerSel + " .chip").forEach((c) =>
    c.classList.toggle("active", c.dataset[attr] === value));
}
$("feedFilters").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  postFilter = b.dataset.filter;
  store.set("postFilter", postFilter);
  syncFilterChips("#feedFilters", "filter", postFilter);
  renderFeed(livePosts);
});
$("execFilters").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  execFilter = b.dataset.efilter;
  store.set("execFilter", execFilter);
  syncFilterChips("#execFilters", "efilter", execFilter);
  if (liveExecs) renderExecs(liveExecs);
});
$("execSearch").addEventListener("input", (e) => {
  execSearch = e.target.value;
  if (liveExecs) renderExecs(liveExecs);
});

/* ---------------- clock, countdown, refresh tick ---------------- */
let lastRefresh = 0;
const RING_C = 97.4;
setInterval(() => {
  const d = new Date();
  $("utcClock").textContent = d.toISOString().slice(11, 19);
  const elapsed = now() - lastRefresh;
  const remain = Math.max(0, CFG.REFRESH_MS - elapsed);
  const rs = Math.ceil(remain / 1000);
  $("refreshIn").textContent = `${Math.floor(rs / 60)}:${String(rs % 60).padStart(2, "0")}`;
  $("ringFg").style.strokeDashoffset = RING_C * (1 - remain / CFG.REFRESH_MS);
  if (liveModel) $("metaUpdated").textContent = `Updated ${relStr(elapsed)}`;
  if (elapsed >= CFG.REFRESH_MS) refresh();
}, 1000);

/* ---------------- scroll spy + back to top + keys ---------------- */
const spy = new IntersectionObserver((entries) => {
  entries.forEach((en) => {
    if (!en.isIntersecting) return;
    document.querySelectorAll("#navLinks a").forEach((a) =>
      a.classList.toggle("active", a.getAttribute("href") === "#" + en.target.id));
  });
}, { rootMargin: "-30% 0px -55% 0px" });
["signals", "feed", "history", "methodology", "report"].forEach((id) => {
  const el = $(id); if (el) spy.observe(el);
});

const toTop = $("toTop");
addEventListener("scroll", () => {
  toTop.classList.toggle("show", scrollY > 700);
}, { passive: true });
toTop.addEventListener("click", () => scrollTo({ top: 0, behavior: "smooth" }));

addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.toLowerCase() === "r") refresh(true);
  if (e.key === "/" ) { e.preventDefault(); $("execSearch").focus(); }
});

addEventListener("resize", () => {
  if (liveModel) drawSpark($("sparkPosts"), liveModel.comm.buckets);
});

/* ---------------- go ---------------- */
$("footYear").textContent = "© " + new Date().getUTCFullYear() + " cheq";
syncFilterChips("#feedFilters", "filter", postFilter);
syncFilterChips("#execFilters", "efilter", execFilter);
buildGaugeTicks();
renderHealth();
refresh();
