# Green preview (plan addition, 10 Oct 2026)

Show each green's shape and general slope on the hole screen: an outline, arrows pointing downhill, and an overall slope figure. It's a rough guide to how the green sits, not a putting read.

Web app only, with no hardware dependency. It slots in as Phase 1b, alongside the OSM course import that was moved forward from Phase 6, and can be built while the tracker hardware is in progress.

## Data sources

| What | Source | Notes |
|---|---|---|
| Green outline | OpenStreetMap `golf=green` polygons via the Overpass API | Free (ODbL, credit "© OpenStreetMap contributors"). Coverage per course unknown until queried. Fallback: trace the outline on the satellite map in the course editor. |
| Heights | Queensland Government QldDem ImageServer (bare-ground LiDAR DTM, 0.5–1 m) | `https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/QldDem/ImageServer`. Credit "© State of Queensland". Confirm licence terms in the Queensland Spatial Catalogue before release. |

Commercial green-reading data (StrackaLine and similar) is licensed and has no public API, so it's out of scope.

## Method

1. Get the green polygon, from OSM or traced.
2. Sample heights on a 1 m grid inside the polygon plus a 3 m border, using `getSamples` or `identify` on the ImageServer.
3. Fit a plane to get the overall fall (direction and %). Then take 3 × 3 m local gradients for the arrows, and mark tiers where the local slope is over about 4%.
4. Store the result on the course hole (`green.polygon`, `green.slope = {grid, plane, capturedAt}`), so it works offline and only needs fetching once.
5. Hole screen: tapping the green opens a preview, showing the outline rotated so the shot direction plays up the screen, downhill arrows sized by slope, the fall in %, and where the ball sits once On green is tapped.

If the phone can't call the service directly (CORS), use a small script in `/analysis` that precomputes each course's greens to JSON, committed to the repo and loaded by the app.

## Limits to show in the app

- LiDAR picks up the main tilt, tiers and false fronts (greens usually fall 1–3%, about 0.25–0.75 m over 25 m). Subtle breaks within a few metres of the hole are near the data's error and won't show.
- Scans can be years old, so a rebuilt green shows its old shape. Show the capture year.

## Done when

Ashgrove and Pine Rivers greens show outlines and slope arrows. The main fall on at least 5 greens matches what the user sees on the course.
