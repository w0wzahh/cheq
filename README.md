# CHEQ

A little status board that answers one question: is there a Roblox ban
wave happening right now? It watches the same things the community
watches and rolls them into a single 0-100 score.

## What it looks at

| Signal | Points | Where it comes from |
|---|---|---|
| Ban talk | 40 | r/robloxhackers posts, matched against a wave word list, weighed by recency and upvotes |
| Detection flags | 25 | Share of tracked executors flagged Detected (WEAO registry) |
| Patch window | 15 | Executors still rebuilding after the latest client |
| Deploy timing | 10 | How fresh the last Windows build is, plus staged builds |
| The rhythm | 10 | Days since the last recorded wave vs. the usual ~90 day pattern |

Verdicts: **0-24 CLEAR · 25-49 ELEVATED · 50-74 HIGH RISK · 75+ WAVE
LIKELY**. If ban talk alone clears 30 points the verdict can't drop
below HIGH RISK.

## Where the data comes from

- **r/robloxhackers**: the included `/api/reddit` function when deployed,
  then the [Arctic Shift](https://arctic-shift.photon-reddit.com)
  archive, then public CORS proxies, then whatever got cached earlier.
- **WEAO** (`weao.xyz`): executor flags plus current and future client
  versions. Works from the browser as-is.
- **The ledger**: wave windows detected by scanning the archive's ban-talk
  history for daily spikes and clustering them. Rebuilt every 12h, cached in
  `localStorage`, nothing hand-written.

## Run it

No build step, it's a static site.

```bash
npx serve .
# or
python -m http.server 8080
```

Opening `index.html` straight from disk works too, the feed just uses
the archive/proxy fallbacks.

## Deploy

Drop it on Vercel to get the server-side Reddit path
(`api/reddit.js` maps to `/api/reddit` on its own):

```bash
npx vercel deploy --prod
```

## Honest notes

- Community data lags and throws false positives. The executor statuses
  are volunteer-maintained. The rhythm is a pattern, not a schedule.
- If the stakes matter, cross-check the sources yourself.
- Not affiliated with Roblox in any way.

## Keys and toggles

- `R` refreshes, `/` jumps to the executor filter box
- Theme toggle in the top bar (follows your OS until you pick one)
- The copy button under the gauge grabs a one-line status summary for
  pasting into Discord
