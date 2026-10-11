"""Probe faster ways to get a height grid from the Queensland DEM:
exportImage as an uncompressed float32 TIFF (one request per green), and
getSamples size limits. Also collects TIFF fixtures for offline tests."""
import json, math, struct, time, urllib.request, urllib.parse, base64

UA = {"User-Agent": "golfStatTracker/0.1 (github.com/trentmac1/golfStatTracker)"}
SVC = "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/QldDem/ImageServer"
R = 6371008.8
OUT = {}

def req(url, data=None, timeout=60):
    body = urllib.parse.urlencode(data).encode() if data else None
    r = urllib.request.urlopen(urllib.request.Request(url, data=body, headers=UA), timeout=timeout)
    return r.status, dict(r.headers), r.read()

def bbox(center, half):
    lat0, lon0 = center
    dlat = half / R * 180 / math.pi
    dlon = half / (R * math.cos(math.radians(lat0))) * 180 / math.pi
    return lon0 - dlon, lat0 - dlat, lon0 + dlon, lat0 + dlat

def read_tiff(b):
    le = b[:2] == b"II"
    E = "<" if le else ">"
    (ifd,) = struct.unpack(E + "I", b[4:8])
    (n,) = struct.unpack(E + "H", b[ifd:ifd + 2])
    tags = {}
    for k in range(n):
        o = ifd + 2 + 12 * k
        tag, typ, cnt = struct.unpack(E + "HHI", b[o:o + 8])
        size = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8}.get(typ, 1) * cnt
        raw = b[o + 8:o + 12] if size <= 4 else b[struct.unpack(E + "I", b[o + 8:o + 12])[0]:][:size]
        fmt = {3: "H", 4: "I", 11: "f", 12: "d", 16: "Q"}.get(typ)
        if fmt:
            vals = struct.unpack(E + fmt * cnt, raw[:struct.calcsize(fmt) * cnt])
            tags[tag] = vals
        else:
            tags[tag] = raw
    return tags, E

for size in [10, 100, 200, 400]:
    pts = [[152.9728 + i * 1e-5, -27.2287] for i in range(size)]
    geom = json.dumps({"points": pts, "spatialReference": {"wkid": 4326}})
    try:
        st, h, body = req(f"{SVC}/getSamples", {"geometry": geom, "geometryType": "esriGeometryMultipoint", "returnFirstValueOnly": "true", "interpolation": "RSP_BilinearInterpolation", "f": "json"})
        d = json.loads(body); print("getSamples", size, "ok" if "samples" in d else d, flush=True)
    except Exception as ex:
        print("getSamples", size, "ERR", ex, flush=True)

for fmt, extra in [("tiff", {"compression": "None"}), ("tiff", {}), ("bsq", {}), ("lerc", {})]:
    x0, y0, x1, y1 = bbox((-27.22870927292386, 152.97288546616107), 25)
    p = {"bbox": f"{x0},{y0},{x1},{y1}", "bboxSR": 4326, "imageSR": 4326, "size": "51,51", "format": fmt,
         "pixelType": "F32", "noData": "-9999", "interpolation": "RSP_BilinearInterpolation", "f": "image", **extra}
    try:
        st, h, body = req(f"{SVC}/exportImage?" + urllib.parse.urlencode(p))
        print("exportImage", fmt, extra, st, h.get("Content-Type"), len(body), "CORS", h.get("Access-Control-Allow-Origin"), body[:8], flush=True)
        if fmt == "tiff":
            tags, E = read_tiff(body)
            print("  tags", {k: (v if len(str(v)) < 120 else str(v)[:120]) for k, v in tags.items() if k in (256, 257, 258, 259, 273, 277, 278, 279, 284, 317, 339, 322, 323, 324, 325)}, flush=True)
    except Exception as ex:
        print("exportImage", fmt, extra, "ERR", ex, flush=True)

# CORS on exportImage as a browser would ask
try:
    r = urllib.request.urlopen(urllib.request.Request(f"{SVC}/exportImage?bbox=152.97,-27.23,152.9701,-27.2299&size=2,2&format=tiff&f=image", headers={**UA, "Origin": "https://trentmac1.github.io"}), timeout=30)
    print("CORS GET exportImage", {k: v for k, v in r.headers.items() if k.lower().startswith("access-control")}, flush=True)
except Exception as ex:
    print("CORS GET ERR", ex)

# Fixtures: uncompressed TIFF grids for some greens, 1 m pixels, 60 m square
centres = {
    "pine-rivers-1": (-27.22870927292386, 152.97288546616107), "pine-rivers-2": (-27.227724382415474, 152.97024250953507),
    "pine-rivers-3": (-27.23117517164926, 152.97341716208962), "pine-rivers-4": (-27.230005352436113, 152.97011397778988),
    "pine-rivers-13": (-27.232981158827567, 152.97512049429076), "ashgrove-a": (-27.4456727, 152.9597306), "ashgrove-b": (-27.4443033, 152.9575579),
}
for k, c in centres.items():
    x0, y0, x1, y1 = bbox(c, 30)
    p = {"bbox": f"{x0},{y0},{x1},{y1}", "bboxSR": 4326, "imageSR": 4326, "size": "61,61", "format": "tiff", "compression": "None",
         "pixelType": "F32", "noData": "-9999", "interpolation": "RSP_BilinearInterpolation", "f": "image"}
    try:
        st, h, body = req(f"{SVC}/exportImage?" + urllib.parse.urlencode(p))
        OUT[k] = {"bbox": [x0, y0, x1, y1], "size": [61, 61], "tiff": base64.b64encode(body).decode()}
        print("fixture", k, len(body), flush=True)
    except Exception as ex:
        print("fixture", k, "ERR", ex, flush=True)
    time.sleep(0.5)
with open("probe-fixtures.json", "w") as f:
    json.dump(OUT, f)
print("done")
