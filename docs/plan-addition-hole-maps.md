# Hole maps from OpenStreetMap (plan addition, 13 Oct 2026)

Show each hole's fairways, tees, bunkers and water in the round previews and on the hole screen, with smooth outlines, and use them to tell where each ball finished: fairway, rough, bunker, water or green.

Decision (Trent): outlines are traced in OpenStreetMap, not in the app. Trent traces any missing holes in OSM's browser editor (iD) over the Esri or Bing imagery, which OSM is permitted to trace from. The app imports them. Everyone using the app benefits, and there's no imagery licence question.

## Data

- Overpass query for `golf=green|hole|bunker|fairway|tee|water_hazard|lateral_water_hazard` (`OSM_KINDS` in `webapp/js/greens.js`, and `analysis/greens/update_osm.py` for the bundled extracts). Credit "© OpenStreetMap contributors (ODbL)".
- Saved per hole as `features = {fairways, tees, bunkers, water, fetchedAt}`, rings stored as `[[lat, lon]]`. Like green outlines, they're not sent to the course server: every phone imports them from OSM.
- The bundled extracts for Ashgrove and Pine Rivers refresh automatically when `update_osm.py` changes on main ("Refresh course map data" workflow), or by running that workflow by hand after new tracing.

## Matching features to holes

`matchFeatures` in `webapp/js/holemap.js`:
- Line of play: the OSM `golf=hole` line (drawn tee to green) whose end is nearest the hole's green, within 50 m. The line's number only breaks ties (it counts as 10 m closer), because mappers sometimes number holes differently from the card. Holes with no green yet use the line with the same number. Without a hole line, tee to green.
- Fairways are matched through the hole lines (updated 13 Oct 2026): each fairway is scored against every hole's line by the metres of line running through it, plus, for a dogleg the line cuts across, the share of its edge lying within 30 m beside the line between the landing area and the green. It goes to the best-scoring hole only, so a neighbouring hole's fairway isn't pulled in. A fairway two holes really share (both lines run 40 m or more through it) goes to both. Minimum to match: 10 m of line through it, or 40% of its edge beside the line.
- Tees: within 70 m of the start of the line and 20 m of it. Bunkers: within 32 m of the line or 35 m of the green. Water: within 45 m of the line.

## Smooth outlines

Mappers often trace with few points, which gives sharp corners. Every outline (greens included) is cleaned (repeated and near-duplicate points dropped), long edges are split into pieces of at most 30 m, then smoothed, so each corner is rounded over up to about 15 m either side:
- Maps: three rounds of Chaikin corner cutting (`smoothRing`). Straight edges stay put; only corners are rounded.
- SVG previews (hole tiles and the green preview): quadratic curves through edge midpoints (`smoothPathD`), the same curve Chaikin converges to, with far fewer points.

Lies are tested against the smoothed shapes, so what you see matches what's reported.

## Hole previews on the course screen (added 13 Oct 2026)

Each course's screen shows a tile for every hole, drawn from its map: tee at the bottom, green at the top, along the line of play (OSM's hole line, so doglegs bend; otherwise tee to green). Tiles show the fairway, tees, water, bunkers, green, the hole number, par and length. Tapping a tile opens that hole on the map editor. The round's hole tiles use the same drawing (`webapp/js/views/holeart.js`).

The line of play is saved with the hole map (`features.line`). Courses mapped before this change draw a straight tee-to-green line until Refresh hole maps is tapped.

Fairway estimate: a par 4 or 5 with no fairway mapped gets a rough fairway, drawn lighter with a dashed edge. It's a 30 m wide strip along the line of play, from where a typical drive lands (a third of the hole, 70–150 m from the tee) to 22 m short of the green, narrowing at the ends so they round off (`estimateFairway` in `holemap.js`). It's only for drawing: lies and the fairway result never use it. The note under the tiles lists which holes are estimated, as a list of what to trace in OSM.

## Ball positions and lies

`lieAt(point, hole)` returns green, bunker, water, fairway, tee or rough. It returns nothing on holes without a map, rather than guessing; rough is only reported when the hole's fairway is mapped (or it's a par 3).
- Each shot gets `startLie` and `endLie` in `deriveHole`. A lie the player set on a shot still wins.
- Shot lists (hole screen and round review) show where each shot finished. Hole tiles and the review map colour each ball position by its lie.
- Fairway result: the player's Hit/Left/Right tap wins; otherwise the drive's finish on the map decides (fairway = hit, otherwise left or right of the line to the green). This replaces the 15 m guess from a tapped target where a map exists.
- Strokes gained uses the mapped lie for each shot's start.

## Limits

- Lies are only as good as the GPS (about 2–3 m from the phone or L76K). A ball within a couple of metres of a fairway or bunker edge can be reported either way; the shot can be dragged to correct it.
- A ball on a neighbouring hole's fairway counts as rough, since only the hole's own fairways are checked.
- Fringe isn't mapped separately; a ball just off the green shows as rough.
- Rounds already played pick up lies once the course's hole maps are downloaded (Courses → the course → Refresh hole maps and green slopes).

## OSM coverage, South East Queensland (13 Oct 2026)

Counted with `analysis/probe/osm_coverage.py` (run by the "OSM coverage" workflow). Features are assigned to courses by bounding box, so counts near shared boundaries are approximate.

Greens and fairways mapped (about a full course):
Brookwater, RACV Royal Pines, Coolangatta & Tweed Heads, Nudgee, Palmer Gold Coast (Robina Woods), Howeston, Pines Course, The Grand, Ashgrove, Carbrook, Palmer Colonial, Royal Queensland, Pacific, Wynnum, Lakelands, Palm Meadows, Brisbane Golf Club, St Lucia Golf Links, Caboolture, Emerald Lakes, Glades, Nambour, Tallebudgera, Mount Coolum, Pine Rivers, Sandy Gallop, Gold Coast Burleigh, Redcliffe, Kooralbyn Valley, Links Hope Island.

Partly mapped: Pacific Harbour (fairways, 12 greens), Palms Course, Lowood (about half), Oxley Golf Complex Corinda, Redland Bay, Surfers Paradise, Oxley (greens but few or no fairways).

Greens only, fairways to trace: Meadowbrook, Southport, Sandgate and Bulimba (9 holes), Jindalee and Wantima (a few holes).

Not mapped beyond the boundary or hole lines: Keperra, Indooroopilly, Virginia, Beerwah, Maroochy River, Caloundra, Gailes, Bribie Island, Headland and others.

## Done when

- Ashgrove and Pine Rivers hole tiles show fairways, bunkers, water and smooth greens, on both the course screen and the round summary.
- A course with no fairways mapped shows an estimated fairway on every par 4 and 5.
- On a played round, at least 15 of 18 drives are labelled with the lie Trent saw on the course.
