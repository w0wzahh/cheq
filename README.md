<div align="center">

# CHEQ

**Is there a Roblox ban wave right now?**

[![Live](https://img.shields.io/badge/live-cheq--orcin.vercel.app-57d0ff?style=for-the-badge)](https://cheq-orcin.vercel.app)
[![Hosted on Vercel](https://img.shields.io/badge/hosted%20on-vercel-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://cheq-orcin.vercel.app)
[![Stack](https://img.shields.io/badge/stack-vanilla%20js%20%2B%20serverless-1b2334?style=for-the-badge)](https://github.com/w0wzahh/cheq)

</div>

CHEQ watches the same signals the community actually watches and rolls
them into a single 0-100 risk score with a plain-language verdict. No
accounts, no tracking, no ads.

## How it reads the room

| Signal | Weight | What it means |
|---|---|---|
| Ban talk | 40 | r/robloxhackers posts matched against a wave lexicon, weighed by recency and upvotes. The sub floods first when a wave lands. |
| Detection flags | 25 | Share of tracked executors currently flagged Detected by Hyperion (WEAO registry). Flags get collected before bans get dropped. |
| Patch window | 15 | Executors still rebuilding after a new client build. Anti-cheat changes ride inside client updates. |
| Deploy timing | 10 | How fresh the last Windows build is, plus whether the next one is already staged. |
| The rhythm | 10 | Days since the last detected wave vs. the ~90 day pattern waves have historically followed. |

Verdict bands: `0-24 CLEAR` · `25-49 ELEVATED` · `50-74 HIGH RISK` ·
`75-100 WAVE LIKELY`. A hard chatter spike alone can floor the verdict
at HIGH RISK.

## The wave ledger

The history section is never hand-written. A server-side scan pages
through the Arctic Shift archive of the subreddit, buckets ban-talk by
day, flags days that beat `max(5, 2.5x median)`, and clusters them into
wave windows. The result is edge-cached for 12h so every visitor shares
one scan instead of each browser paging the archive itself.

## Architecture

```
browser
  |-- /api/reddit   ->  reddit json -> arctic shift -> cached payload
  |-- /api/ledger   ->  paged archive scan -> spike clustering -> 12h edge cache
  |-- weao.xyz      ->  executor flags + client versions (direct, CORS open)
  '-- static assets ->  index.html / styles.css / app.js / favicon.svg
```

```
cheq/
  index.html        the whole UI shell
  styles.css        theme system, dark + light
  app.js            fetching, scoring engine, rendering
  favicon.svg
  api/
    reddit.js       server-side live feed proxy, 5 min cache
    ledger.js       server-side wave scan, 12h edge cache
  vercel.json       headers
```

## Run it locally

Fully static, no build step.

```bash
npx serve .
# or
python -m http.server 8080
```

Without the `/api` functions the site degrades gracefully: the feed and
ledger scan run in the browser via the Arctic Shift archive and public
proxies.

## Deploy

**Vercel** (recommended, and where it lives): import the repo, preset
`Other`, deploy. Both functions in `api/` map automatically.

**GitHub Pages** works as a static mirror: Settings > Pages > `main` /
root. The `/api` routes don't run there; the client-side fallbacks take
over.

## Data sources

- [r/robloxhackers](https://www.reddit.com/r/robloxhackers/) community
  posts, via the included proxy or the
  [Arctic Shift](https://arctic-shift.photon-reddit.com) research archive
- [WEAO registry](https://weao.xyz) executor detection flags and Roblox
  client versions
- The wave ledger described above, plus spikes the local instance
  records itself in `localStorage`

## Honest notes

- Community data lags and throws false positives. Executor statuses are
  volunteer-maintained. The rhythm is a pattern, not a schedule.
- If the stakes matter, cross-check the sources yourself.
- Not affiliated with Roblox Corporation in any way.

## Shortcuts and toggles

- `R` refreshes, `/` jumps to the executor filter
- Theme toggle in the top bar, follows your OS until you pick one
- The copy button under the gauge grabs a one-line status summary

<div align="center">

Made by [w0wzahh](https://github.com/w0wzahh) with love

</div>
