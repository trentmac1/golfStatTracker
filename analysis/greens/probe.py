"""One-off probe: what do OpenStreetMap and the Queensland DEM return for our courses?"""
import json, urllib.request, urllib.parse

UA = {"User-Agent": "golfStatTracker/0.1 (github.com/trentmac1/golfStatTracker)"}

def post(url, data):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(), headers=UA)
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.status, dict(r.headers), r.read().decode()

def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.status, dict(r.headers), r.read().decode()

print("=== Overpass ===")
q = """[out:json][timeout:60];
(way["leisure"="golf_course"]["name"~"Ashgrove|Pine Rivers",i];relation["leisure"="golf_course"]["name"~"Ashgrove|Pine Rivers",i];)->.c;
.c out tags center;
.c map_to_area->.a;
(way["golf"~"^(green|hole|tee|bunker)$"](area.a);relation["golf"="green"](area.a););
out tags center;"""
st, h, body = post("https://overpass-api.de/api/interpreter", {"data": q})
d = json.loads(body)
from collections import Counter
print("status", st, "elements", len(d["elements"]))
for e in d["elements"]:
    t = e.get("tags", {})
    if t.get("leisure") == "golf_course":
        print("COURSE", e["type"], e["id"], t.get("name"), e.get("center"))
print(Counter((e.get("tags", {}).get("golf")) for e in d["elements"]))
for e in d["elements"]:
    t = e.get("tags", {})
    if t.get("golf") == "hole":
        print("HOLE ref", t.get("ref"), "par", t.get("par"), e.get("center"))
greens = [e for e in d["elements"] if e.get("tags", {}).get("golf") == "green"]
for e in greens[:50]:
    print("GREEN", e["id"], e.get("tags", {}).get("ref"), e.get("center"))

print("=== QldDem getSamples ===")
base = "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/QldDem/ImageServer"
pts = [[152.97288546616107, -27.22870927292386], [152.97295162631946, -27.228756459219074], [152.97279374412324, -27.22864806652538]]
geom = json.dumps({"points": pts, "spatialReference": {"wkid": 4326}})
for path, extra in [("getSamples", {"geometry": geom, "geometryType": "esriGeometryMultipoint", "returnFirstValueOnly": "true", "interpolation": "RSP_BilinearInterpolation", "outFields": "*", "f": "json"})]:
    try:
        st, h, body = post(f"{base}/{path}", extra)
        print(path, st, "CORS:", h.get("Access-Control-Allow-Origin"), body[:1500])
    except Exception as ex:
        print(path, "ERR", ex, getattr(ex, "read", lambda: b"")()[:500])
# CORS preflight check like a browser would send
req = urllib.request.Request(f"{base}/getSamples", method="OPTIONS", headers={**UA, "Origin": "https://trentmac1.github.io", "Access-Control-Request-Method": "POST"})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print("OPTIONS", r.status, {k: v for k, v in r.headers.items() if k.lower().startswith("access-control")})
except Exception as ex:
    print("OPTIONS ERR", ex)
st, h, body = get(f"{base}/identify?geometry=152.9729,-27.2287&geometryType=esriGeometryPoint&sr=4326&returnGeometry=false&returnCatalogItems=false&f=json")
print("identify", st, "CORS:", h.get("Access-Control-Allow-Origin"), body[:600])
# DEM time series: which capture/year covers this spot?
ts = "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/DEM_TimeSeries_AllUsers/ImageServer"
try:
    st, h, body = get(f"{ts}/identify?geometry=152.9729,-27.2287&geometryType=esriGeometryPoint&sr=4326&returnGeometry=false&returnCatalogItems=true&returnPixelValues=true&maxItemCount=5&f=json")
    print("timeseries identify", st, body[:2500])
except Exception as ex:
    print("timeseries ERR", ex)
