# Green preview

Tap the green button on the hole map (the flag in an oval) to see the green from above, turned so you're looking at it from where you'll play: from you when you're on the hole, otherwise from your last shot, the hole line or the tee.

- **Outline** from OpenStreetMap (`golf=green`), matched to holes by the `golf=hole` line's number. A green you placed yourself wins over the map's hole line, which is sometimes numbered differently from the card (Pine Rivers hole 13). Without an OSM outline, an oval is drawn from your front and back points.
- **Heights** from the Queensland Government's bare-ground LiDAR terrain model (QldDem ImageServer, 0.5–1 m), fetched as one uncompressed float32 TIFF per green (`exportImage`). The service allows requests from the app's address (CORS checked for `https://trentmac1.github.io`). Pine Rivers is covered by the Moreton Bay 2018 survey.
- **Analysis:** a plane fitted over the green gives the overall fall (% and direction, described relative to your line). Arrows show local downhill direction from gradients over 5 m, hidden under 1%, so LiDAR noise of a few centimetres doesn't show as false breaks. Shading runs light (high) to dark (low), with contour lines every 10 cm (20 cm on greens with more than 1.2 m of relief).
- **Saved with the course** after one download (Courses → Get green shapes and slopes, or from the preview), so it works without signal. Built-in courses use bundled OSM extracts in `webapp/data/osm/`, refreshed by the "Refresh course map data" workflow; other courses query Overpass from the phone.
- The outline also improves stats: an approach counts as on the green when it finishes inside the outline, instead of within a fixed radius.

## Limits

- It shows the main tilt, tiers and false fronts. Breaks within a few metres of the hole are near the data's error and won't show.
- Surveys can be years old, so a rebuilt green shows its old shape. The preview names the survey year.
- Only Queensland has this height data. Elsewhere the outline still draws, with no slope.

Credits: green outlines © OpenStreetMap contributors (ODbL 1.0). Heights © State of Queensland (QldDem).
