"""Orientation check: single-point heights 15 m N/S/E/W of a green centre,
to compare with the exportImage grid (row 0 should be north)."""
import json, math, urllib.request, urllib.parse
UA = {"User-Agent": "golfStatTracker/0.1 (github.com/trentmac1/golfStatTracker)"}
SVC = "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/QldDem/ImageServer"
R = 6371008.8
lat0, lon0 = -27.23117517164926, 152.97341716208962  # Pine Rivers hole 3 green
pts = []
for name, x, y in [("C", 0, 0), ("N15", 0, 15), ("S15", 0, -15), ("E15", 15, 0), ("W15", -15, 0)]:
    pts.append((name, lon0 + x / (R * math.cos(math.radians(lat0))) * 180 / math.pi, lat0 + y / R * 180 / math.pi))
geom = json.dumps({"points": [[p[1], p[2]] for p in pts], "spatialReference": {"wkid": 4326}})
body = urllib.parse.urlencode({"geometry": geom, "geometryType": "esriGeometryMultipoint", "returnFirstValueOnly": "true",
                               "interpolation": "RSP_BilinearInterpolation", "f": "json"}).encode()
d = json.loads(urllib.request.urlopen(urllib.request.Request(f"{SVC}/getSamples", data=body, headers=UA), timeout=60).read())
for s in d["samples"]:
    print(pts[s["locationId"]][0], s["value"])
