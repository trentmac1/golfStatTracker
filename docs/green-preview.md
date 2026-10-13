# Green preview

Tap the green button on the hole map (the flag in an oval) to see the green from above, turned so you're looking at it from where you'll play: from you when you're on the hole, otherwise from your last shot, the hole line or the tee.

- **Outline** from OpenStreetMap (`golf=green`), matched to holes by the `golf=hole` line's number. A green you placed yourself wins over the map's hole line, which is sometimes numbered differently from the card (Pine Rivers hole 13). Without an OSM outline, an oval is drawn from your front and back points.
- **Heights** from the Queensland Government's bare-ground LiDAR terrain model (QldDem ImageServer, 0.5–1 m), fetched as one uncompressed float32 TIFF per green (`exportImage`). The service allows requests from the app's address (CORS checked for `https://trentmac1.github.io`). Pine Rivers is covered by the Moreton Bay 2018 survey.
- **Analysis:** a plane fitted over the green gives the overall fall (% and direction, described relative to your line). Arrows show local downhill direction from gradients over 5 m, hidden under 1%, so LiDAR noise of a few centimetres doesn't show as false breaks. Shading runs light (high) to dark (low), with contour lines every 10 cm (20 cm on greens with more than 1.2 m of relief).
- **Saved with the course** after one download (Courses → Get green shapes and slopes, or from the preview), so it works without signal. Built-in courses use bundled OSM extracts in `webapp/data/osm/`, refreshed by the "Refresh course map data" workflow; other courses query Overpass from the phone.
- The outline also improves stats: an approach counts as on the green when it finishes inside the outline, instead of within a fixed radius.

## Adding courses from the map

Courses → Add a course searches OpenStreetMap by name (Nominatim) or lists courses within 25 km (Overpass). Picking one downloads the course's golf features and builds the course: the number of holes and pars from the numbered `golf=hole` lines (stroke index too, when tagged), tees from the start of each line, and greens as above. If the holes aren't numbered on the map, the course is created blank for you to fill in.

When the map has gaps:
- **Pars** missing from hole lines are estimated from the line's length (tee to green centre): under 225 m par 3, under 400 m par 4, otherwise par 5. On Pine Rivers and Ashgrove this gets all 36 holes right. Estimated pars are marked "est." until you confirm or change them by tapping the right par on the course screen.
- **Greens** without outlines are placed at the end of the hole line (approximate), and replaced when you tap On green or place them on the map.
- **Scorecard lookup (GolfCourseAPI):** with your own key (Backup & settings, kept on the phone and out of backups), a course's screen can fill pars, hole lengths, rating and slope per tee. Checked Oct 2026: Pine Rivers, Ashgrove, Keperra, Wantima, Nudgee and Brookwater have full cards; North Pine isn't listed; none include stroke indexes. Its terms allow caching for use in your own app but not republishing, so the data stays on the phone. A lookup takes two requests (search, then the full card); free keys allow 35 a day.
- **OpenGolfAPI** (open, ODbL) only covers the US so far.

## Limits

- It shows the main tilt, tiers and false fronts. Breaks within a few metres of the hole are near the data's error and won't show.
- Surveys can be years old, so a rebuilt green shows its old shape. The preview names the survey year.
- Only Queensland has this height data. Elsewhere the preview shows the outline with no slope, and distances use the mapped greens.

Credits: green outlines © OpenStreetMap contributors (ODbL 1.0). Heights © State of Queensland (QldDem).
