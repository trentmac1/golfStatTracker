"""Refresh the bundled OpenStreetMap extracts (greens, hole lines, bunkers,
fairways, tees and water) for
the app's built-in courses. Run by the "Refresh course map data" workflow.
The app ships these so built-in courses don't depend on the public Overpass
servers, which are often busy. Heights are always fetched by the phone."""
import json, time, urllib.request, urllib.parse
from datetime import date

COURSES = {
    "pine-rivers": "-27.2370,152.9650,-27.2250,152.9790",
    "ashgrove": "-27.4480,152.9540,-27.4390,152.9680",
}
SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
UA = {"User-Agent": "golfStatTracker (github.com/trentmac1/golfStatTracker)"}

def overpass(q):
    for attempt in range(4):
        for srv in SERVERS:
            try:
                req = urllib.request.Request(srv, data=urllib.parse.urlencode({"data": q}).encode(), headers=UA)
                with urllib.request.urlopen(req, timeout=120) as r:
                    return json.loads(r.read().decode())
            except Exception as ex:
                print("overpass", srv, "failed:", ex, flush=True)
        time.sleep(30)
    raise SystemExit("All Overpass servers failed")

for key, bbox in COURSES.items():
    d = overpass(f'[out:json][timeout:90];(way["golf"~"^(green|hole|bunker|fairway|tee|water_hazard|lateral_water_hazard)$"]({bbox}););out tags geom;')
    els = [{"type": e["type"], "id": e["id"],
            "tags": {k: v for k, v in e.get("tags", {}).items() if k in ("golf", "ref", "par", "name")},
            "geometry": [{"lat": round(g["lat"], 7), "lon": round(g["lon"], 7)} for g in e.get("geometry", [])]}
           for e in d["elements"]]
    greens = sum(1 for e in els if e["tags"].get("golf") == "green")
    fairways = sum(1 for e in els if e["tags"].get("golf") == "fairway")
    print(key, "elements", len(els), "greens", greens, "fairways", fairways, flush=True)
    if greens < 9:
        print("Too few greens, keeping the old file", flush=True)
        continue
    out = {"note": "Extract from OpenStreetMap, © OpenStreetMap contributors, available under the Open Database Licence (ODbL) 1.0. https://www.openstreetmap.org/copyright",
           "extracted": date.today().isoformat(), "elements": els}
    with open(f"webapp/data/osm/{key}.json", "w") as f:
        json.dump(out, f, separators=(",", ":"))
