"""Count the golf features mapped in OpenStreetMap for each golf course in
South East Queensland, to show which courses already have greens and fairways.
Run by the "OSM coverage" workflow; writes osm-coverage.md."""
import json, time, urllib.request, urllib.parse

BBOX = "-28.25,152.40,-26.40,153.60"   # Gold Coast to Noosa, out to Ipswich
SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
UA = {"User-Agent": "golfStatTracker coverage check (github.com/trentmac1/golfStatTracker)"}
KINDS = ["green", "fairway", "tee", "bunker", "rough", "water", "hole"]

def overpass(q):
    for _ in range(4):
        for srv in SERVERS:
            try:
                req = urllib.request.Request(srv, data=urllib.parse.urlencode({"data": q}).encode(), headers=UA)
                with urllib.request.urlopen(req, timeout=200) as r:
                    return json.loads(r.read().decode())
            except Exception as ex:
                print("overpass", srv, "failed:", ex, flush=True)
        time.sleep(30)
    raise SystemExit("All Overpass servers failed")

courses = overpass(f'[out:json][timeout:180];nwr["leisure"="golf_course"]({BBOX});out tags center bb;')["elements"]
feats = overpass(f'[out:json][timeout:180];nwr["golf"]({BBOX});out tags center;')["elements"]
rows = []
for c in courses:
    b = c.get("bounds")
    if not b: continue
    rows.append({"name": c.get("tags", {}).get("name", f"(unnamed {c['type']}/{c['id']})"), "b": b,
                 "area": (b["maxlat"] - b["minlat"]) * (b["maxlon"] - b["minlon"]), "n": dict.fromkeys(KINDS, 0)})
for f in feats:
    p = f.get("center") or ({"lat": f["lat"], "lon": f["lon"]} if "lat" in f else None)
    g = f.get("tags", {}).get("golf")
    if not p or not g: continue
    kind = "water" if "water" in g else g
    if kind not in KINDS: continue
    inside = [r for r in rows if r["b"]["minlat"] <= p["lat"] <= r["b"]["maxlat"] and r["b"]["minlon"] <= p["lon"] <= r["b"]["maxlon"]]
    if inside: min(inside, key=lambda r: r["area"])["n"][kind] += 1
rows.sort(key=lambda r: (-(r["n"]["green"] > 0) - (r["n"]["fairway"] > 0), -r["n"]["fairway"], -r["n"]["green"], r["name"]))
out = [f"OSM golf coverage, South East Queensland, bbox {BBOX}, {time.strftime('%Y-%m-%d')}", "",
       "| Course | " + " | ".join(KINDS) + " |", "|---|" + "---|" * len(KINDS)]
out += [f"| {r['name']} | " + " | ".join(str(r["n"][k]) for k in KINDS) + " |" for r in rows]
open("osm-coverage.md", "w").write("\n".join(out) + "\n")
print("\n".join(out))
