# Golf Tracker

An Arccos-style golf stat system: a pocket shot tracker (Seeed XIAO nRF52840 Sense + L76K GNSS) and an iPhone web app that records the round and works out the stats.

| Folder | What's in it | Status |
|---|---|---|
| `webapp/` | Offline-first PWA (plain HTML/CSS/JS, IndexedDB) | **Phase 1 done: manual mode** |
| `firmware/` | PlatformIO project for the tracker | Phase 2 |
| `analysis/` | Python notebooks for tuning swing detection | Phase 4 |
| `docs/` | BLE protocol, shot record format, green preview spec | Draft |

Setup: right-handed, tracker in the front trouser pocket, home course Ashgrove Golf Club, hosted on GitHub Pages.

## Roadmap

1. Web app, manual mode: **built**, on-course test pending
1b. Green preview: **built**: outlines from OpenStreetMap, slopes from Queensland LiDAR ([details](docs/green-preview.md))
2. Tracker bring-up: IMU, mic, GPS, BLE status in Bluefy
3. Training data capture
4. Offline analysis
5. On-device detection and sync
6. Polish: club suggestions, strokes gained, power tuning, enclosure

## Put the app on your iPhone (GitHub Pages)

1. Create a new repository on github.com (this one is `golfStatTracker`). It can be private only on a paid plan; on a free account make it public. No personal data goes in the repo: rounds stay on the phone.
2. Upload this folder's contents (drag the files into **Add file › Upload files**, or `git push`). Keep the `.github` folder; it holds the deploy workflow.
3. In the repo, open **Settings › Pages** and set **Source** to **GitHub Actions**.
4. Open the **Actions** tab. The *Deploy web app* workflow runs on every push to `main`; when it's green, the site is at https://trentmac1.github.io/golfStatTracker/.
5. On the iPhone, open that address in **Safari**, tap **Share › Add to Home Screen**. Open it from the Home Screen icon, allow location when asked.
6. Open it once with signal so the map library and the satellite imagery around the course get cached. Panning over Ashgrove at home on Wi-Fi pre-loads the imagery for the course.

When you change the app later, bump `VERSION` in `webapp/sw.js` so phones fetch the new files (they update on the next launch).

## Run it locally

```
cd webapp
python3 -m http.server 8000      # then open http://localhost:8000
node --test tests/*.test.mjs     # stats and miss-direction tests
```

Geolocation needs HTTPS on a phone, so test on the phone through GitHub Pages.

## How the app works

- **Starting a round**: choose 18 or 9 holes and which nines. Courses with more than 18 holes are split into nines (1–9, 10–18, 19–27), so you can play e.g. 10–18 then 19–27, or start on the back nine. The choice is remembered per course. Set a course's size (9/18/27/36) on its Courses screen.
- **Mark ball**: stand at your ball before each shot and tap it. The phone takes a few seconds of GPS fixes and uses the median of the best ones. A shot's distance runs to the next mark.
- **On green**: tap it standing at your ball on the green. It measures your last shot to the ball, and on a hole with no green yet it saves an approximate green for the course.
- **Measure**: tap anywhere on the hole map (a bunker, water, a layup spot) to see the distance from you to that point and from there to the green. Drag the yellow ring to adjust; tap × to clear.
- **Map faces the hole**: the hole map turns so the line from you (or your last shot) to the green runs up the screen, and re-aims when you walk to your ball or mark a shot. The compass button switches to north-up and back.
- **Green preview**: the flag button on the hole map shows the green from your side, with downhill arrows, shading and 10 cm contours. Get the data once per course under Courses (or from the preview); it's saved for offline use. See [docs/green-preview.md](docs/green-preview.md).
- **Full-screen map**: the button under ◎ fills the screen with the map, keeping Mark ball and On green at the bottom. It stays on for the next hole until you turn it off.
- **Putts, tee shot result, chips, bunker shots, penalties** are taps on the hole screen. Score = marked shots + putts + penalties, and can be overridden.
- Tap a shot to set its club, lie, a penalty or mishit, or a target point on the map (for tee shots). Drag any dot on the map to correct a bad GPS position; drag the yellow flag to move the green centre.
- **Add a course** (Courses screen): search by name or list courses near you. Courses mapped in OpenStreetMap arrive with their holes, pars, tees, green centres, fronts, backs and outlines filled in, plus slopes in Queensland. Check the pars against the card and add the rating, slope and stroke indexes.
- **Courses › Place greens on the map**: set every green centre (and tees, front and back) from home on the satellite map, so distances to the green work from the first round.
- **Backup**: JSON export/import (import merges, never deletes) and CSV export of holes and shots.

### Strokes gained, clubs to work on, handicap

- **Strokes gained** compares each shot with a PGA Tour player from the same spot, using Mark Broadie's published baseline: shot value = expected strokes before − expected strokes after − 1 − penalties. It's split into off the tee (par 4/5 tee shots), approach, around the green (inside 45 m) and putting, per round. Against a tour baseline every area shows a loss, so compare the areas with each other.
  - Distances are to the green centre, because the pin isn't recorded.
  - Untagged lies: the shot after a par 4/5 drive uses your fairway tap (Left/Right = rough); a hole's bunker count goes to its last shots inside 45 m; otherwise the average of fairway and rough.
  - Putting uses the optional **First putt length** on the hole screen, otherwise an estimate from where your ball sat on the green.
  - Holes are skipped if unfinished, if there's no green set, or if a hand-edited score doesn't match the marked shots.
- **Clubs to work on** ranks clubs (3+ tagged shots) by strokes lost per shot, with mishit rate, penalties and their usual miss.
- **Handicap estimate** follows the World Handicap System as used by Golf Australia: differential = (113 ÷ slope) × (adjusted score − course rating), holes capped at net double bogey, then the average of your lowest differentials (lowest 1 of 3 − 2.0, up to best 8 of the most recent 20). It needs each course's rating, slope and stroke indexes (Courses screen), and rounds of 14+ holes. It's an estimate, not an official handicap.

### Stat definitions

- Miss direction uses the plan's formula: `long = d·û − |T−S|`, `right = d_x·û_y − d_y·û_x`. A shot is treated as aimed at the green if it's the last shot before putting, it finished within 50 m of the green, or it's a par-3 tee shot. Layups get no miss unless you tap a target.
- On the green: inside a radius of half the front-to-back distance, or 12 m when front/back aren't set.
- GIR: strokes before putting ≤ par − 2. Scrambling: missed GIR, made par or better.
- Sand save (for now): a hole with a bunker shot that finished with one putt or fewer.
- Club distances: median and middle 50%, excluding mishits, penalty shots, and last shots measured only to the green centre.
- Fairway: your Hit/Left/Right/Short tap. If you tap a tee target instead, it's inferred (within 15 m of the line = hit).

## Phase 1 on-course checklist

Before the round
- [ ] Pars match the card in the pro shop (Courses › Ashgrove). Online scorecards disagree on a few holes.
- [ ] At least a few greens placed on the map, so live distances show.
- [ ] App opened from the Home Screen icon, location allowed.

During the round (18 holes)
- [ ] Mark ball before every full shot and chip, including tee shots; On green on every green.
- [ ] Note any hole where the distance to centre looked wrong compared with a sprinkler head or marker.
- [ ] Check 3–4 shot distances against a known reference (a 150 m marker, a laser if a partner has one).
- [ ] Set clubs on at least the tee shots.
- [ ] Turn on Airplane Mode for a hole and confirm everything still works.

After the round
- [ ] Scorecard total matches your real score.
- [ ] Miss directions on approaches look right (short/long/left/right).
- [ ] Export a backup and confirm the file opens in the Files app.
- [ ] Note anything that took too many taps or was hard to read in the sun.

Send back: the score check, any distance that looked wrong (hole and shot), the GPS accuracy figures you saw, and what was awkward.
