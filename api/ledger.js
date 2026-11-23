// Server-side wave ledger builder. Runs the whole archive scan in the
// function so visitors share one cached result instead of each browser
// paging the archive themselves. Edge-cached 12h via Cache-Control.

const SUB = "robloxhackers";
const QUERIES = ["ban", "terminated"];
const MAX_PAGES = 8;
const PAGE_GAP_MS = 900;
const SPIKE_MIN = 5;
const SPIKE_MULT = 2.5;
const WAVE_GAP_D = 3;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

let cache = { at: 0, payload: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayKey = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

async function arcticSearch(extra) {
  const url = `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${SUB}&limit=100&sort=desc&${extra}`;
  for (let a = 0; a < 3; a++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": UA } });
      clearTimeout(t);
      if (r.ok) return await r.json();
      if (r.status === 422 || r.status === 429) { await sleep(1500 * (a + 1)); continue; }
      return null;
    } catch {
      await sleep(1500 * (a + 1));
    }
  }
  return null;
}

function wavesFromCounts(byDay) {
  const entries = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return [];
  const counts = entries.map(([, n]) => n).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] || 1;
  const floor = Math.max(SPIKE_MIN, median * SPIKE_MULT);
  const spikes = entries.filter(([, n]) => n >= floor).map(([d, n]) => ({ d, n }));
  if (!spikes.length) return [];

  const waves = [];
  let cur = { start: spikes[0].d, end: spikes[0].d, peak: spikes[0].d, peakN: spikes[0].n, total: spikes[0].n, days: 1 };
  for (let i = 1; i < spikes.length; i++) {
    const s = spikes[i];
    const gap = (new Date(s.d) - new Date(cur.end)) / 864e5;
    if (gap <= WAVE_GAP_D) {
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (cache.payload && Date.now() - cache.at < 12 * 3600e3) {
    res.setHeader("Cache-Control", "s-maxage=43200, stale-while-revalidate=3600");
    res.setHeader("X-Cheq-Cache", "HIT");
    return res.status(200).json(cache.payload);
  }

  const byDay = {};
  const seenIds = new Set();
  let oldest = Infinity;

  for (const q of QUERIES) {
    let before = null;
    for (let page = 0; page < MAX_PAGES; page++) {
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
      await sleep(PAGE_GAP_MS);
    }
    await sleep(PAGE_GAP_MS);
  }

  if (!seenIds.size) {
    if (cache.payload) {
      res.setHeader("X-Cheq-Cache", "STALE");
      return res.status(200).json(cache.payload);
    }
    return res.status(502).json({ waves: [], error: "archive unreachable" });
  }

  const waves = wavesFromCounts(byDay);
  const coveredD = oldest === Infinity ? 0 : (Date.now() - oldest * 1000) / 864e5;
  const payload = {
    at: Date.now(),
    waves,
    coverFrom: oldest === Infinity ? null : dayKey(oldest),
    solid: waves.length > 0 && coveredD >= 60,
    posts: seenIds.size,
  };
  cache = { at: Date.now(), payload };

  // long edge cache only for solid scans; thin results expire fast
  res.setHeader("Cache-Control", payload.solid ? "s-maxage=43200, stale-while-revalidate=3600" : "s-maxage=300, stale-while-revalidate=60");
  res.setHeader("X-Cheq-Source", "arctic-shift");
  return res.status(200).json(payload);
}
