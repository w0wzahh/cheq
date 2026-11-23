// Vercel serverless function. Fetches r/robloxhackers server-side because
// browsers hitting Reddit directly get 403s. Caches 5 min and falls back to
// the Arctic Shift archive when Reddit refuses the datacenter IP.

const SUB = "robloxhackers";
const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, payload: null };

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function timedFetch(url, opts = {}, ms = 9000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ctl.signal,
      headers: { "User-Agent": UA, Accept: "application/json", ...(opts.headers || {}) },
      redirect: "follow",
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function normalize(children) {
  return {
    posts: children
      .map((c) => (c.data ? c.data : c))
      .map((p) => ({
        id: p.id || p.name,
        title: p.title || "",
        selftext: (p.selftext || "").slice(0, 1200),
        score: p.score ?? 0,
        num_comments: p.num_comments ?? 0,
        created_utc: p.created_utc ?? null,
        permalink: p.permalink ? "https://www.reddit.com" + p.permalink : null,
        link_flair_text: p.link_flair_text || null,
      }))
      .filter((p) => p.created_utc && p.title),
  };
}

async function fromReddit() {
  const j = await timedFetch(
    `https://www.reddit.com/r/${SUB}/new.json?limit=100&raw_json=1`
  );
  return normalize(j?.data?.children || []);
}

async function fromArctic() {
  const j = await timedFetch(
    `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${SUB}&limit=100&sort=desc`,
    { headers: { "User-Agent": UA } }
  );
  return { posts: j.data || [] };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");

  if (cache.payload && Date.now() - cache.at < CACHE_MS) {
    res.setHeader("X-Cheq-Cache", "HIT");
    return res.status(200).json(cache.payload);
  }

  try {
    const payload = await fromReddit();
    if (!payload.posts.length) throw new Error("empty feed");
    cache = { at: Date.now(), payload };
    res.setHeader("X-Cheq-Source", "reddit");
    return res.status(200).json(payload);
  } catch {
    try {
      const payload = await fromArctic();
      if (payload.posts.length) {
        cache = { at: Date.now(), payload };
        res.setHeader("X-Cheq-Source", "arctic-shift");
        return res.status(200).json(payload);
      }
    } catch {}
  }

  if (cache.payload) {
    res.setHeader("X-Cheq-Cache", "STALE");
    return res.status(200).json(cache.payload);
  }
  return res.status(502).json({ posts: [], error: "all upstream sources unreachable" });
}
