"""Collect test fixtures for the green preview: OpenStreetMap golf geometry and
Queensland LiDAR height grids around each green. Output goes to a branch so the
app's processing can be tested offline against real data."""
import json, math, time, urllib.request, urllib.parse

UA = {"User-Agent": "golfStatTracker/0.1 (github.com/trentmac1/golfStatTracker)"}
OUT = {}

def post(url, data, timeout=90):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(), headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]

def overpass(q):
    for attempt in range(3):
        for srv in SERVERS:
            try:
                return post(srv, {"data": q}, timeout=120)
            except Exception as ex:
                print("overpass", srv, "ERR", ex, flush=True)
        time.sleep(20)
    return None

for key, bbox in [("pine-rivers", "-27.2370,152.9650,-27.2250,152.9790"), ("ashgrove", "-27.4480,152.9540,-27.4390,152.9680")]:
    q = f"""[out:json][timeout:90];
(way["golf"~"^(green|hole|tee|fairway|bunker)$"]({bbox});way["leisure"="golf_course"]({bbox}););
out tags geom;"""
    d = overpass(q)
    print(key, "osm elements", None if d is None else len(d["elements"]), flush=True)
    OUT[f"osm-{key}"] = d

BASE = "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/QldDem/ImageServer/getSamples"
R = 6371008.8

def grid(center, half=25, step=1.0):
    lat0, lon0 = center
    n = int(2 * half / step) + 1
    pts = []
    for j in range(n):          # south -> north
        for i in range(n):      # west -> east
            x = -half + i * step
            y = -half + j * step
            lat = lat0 + (y / R) * 180 / math.pi
            lon = lon0 + (x / (R * math.cos(math.radians(lat0)))) * 180 / math.pi
            pts.append([round(lon, 8), round(lat, 8)])
    return n, pts

def samples(pts):
    vals, meta = [], None
    for k in range(0, len(pts), 900):
        chunk = pts[k:k + 900]
        geom = json.dumps({"points": chunk, "spatialReference": {"wkid": 4326}})
        d = post(BASE, {"geometry": geom, "geometryType": "esriGeometryMultipoint", "returnFirstValueOnly": "true",
                        "interpolation": "RSP_BilinearInterpolation", "outFields": "name", "f": "json"})
        if "samples" not in d:
            print("DEM error", d, flush=True); return None, None
        byId = {s["locationId"]: s for s in d["samples"]}
        for i in range(len(chunk)):
            s = byId.get(i)
            v = s and s.get("value")
            try: vals.append(round(float(v), 3))
            except (TypeError, ValueError): vals.append(None)
            if s and not meta: meta = (s.get("attributes") or {}).get("name")
    return vals, meta

greens = {
    "pine-rivers": [(-27.22870927292386, 152.97288546616107), (-27.227724382415474, 152.97024250953507), (-27.23117517164926, 152.97341716208962),
                    (-27.230005352436113, 152.97011397778988), (-27.228579356450542, 152.96999820973843), (-27.23074245034067, 152.97337572727247)],
}
ash = OUT.get("osm-ashgrove") or {"elements": []}
ag = [e for e in ash["elements"] if e.get("tags", {}).get("golf") == "green"][:4]
greens["ashgrove"] = [(sum(p["lat"] for p in e["geometry"]) / len(e["geometry"]), sum(p["lon"] for p in e["geometry"]) / len(e["geometry"])) for e in ag]

DEM = {}
for key, cs in greens.items():
    for idx, c in enumerate(cs):
        n, pts = grid(c)
        vals, name = samples(pts)
        DEM[f"{key}-{idx + 1}"] = {"center": c, "half": 25, "step": 1.0, "n": n, "z": vals, "dataset": name}
        print(key, idx + 1, "dataset", name, "nulls", None if vals is None else sum(v is None for v in vals), flush=True)
OUT["dem"] = DEM

with open("probe-fixtures.json", "w") as f:
    json.dump(OUT, f)
print("done", flush=True)
