"""Probe course search: Nominatim free text vs 'golf course' in a viewbox, and Overpass 'around'."""
import json, urllib.request, urllib.parse
UA = {"User-Agent": "golfStatTracker/0.1 (github.com/trentmac1/golfStatTracker)", "Referer": "https://trentmac1.github.io/golfStatTracker/"}
def get(url):
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers={**UA, "Origin": "https://trentmac1.github.io"}), timeout=60)
        return r.status, dict(r.headers), json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()[:200]
N = "https://nominatim.openstreetmap.org/search?"
for q in ["kaperra", "keperra", "keperra golf", "wantima", "wantima golf", "wantima country club", "indooroopilly golf"]:
    st, h, d = get(N + urllib.parse.urlencode({"q": q, "format": "jsonv2", "limit": 10}))
    print(f"\n## q={q!r} status {st} CORS {h.get('Access-Control-Allow-Origin')}")
    if isinstance(d, list):
        for r in d: print("  ", r.get("category"), r.get("type"), "|", r.get("name"), "|", r.get("display_name")[:90])
# golf courses in a ~50 km box around Brisbane
lat, lon = -27.45, 152.98
for amen in ["golf course", "[leisure=golf_course]"]:
    vb = f"{lon-0.5},{lat+0.5},{lon+0.5},{lat-0.5}"
    st, h, d = get(N + urllib.parse.urlencode({"q": amen, "format": "jsonv2", "limit": 40, "viewbox": vb, "bounded": 1}))
    print(f"\n## viewbox q={amen!r} status {st} count {len(d) if isinstance(d, list) else d}")
    if isinstance(d, list):
        print("  ", sorted(r.get("name") or r.get("display_name")[:40] for r in d))
# structured amenity search
st, h, d = get(N + urllib.parse.urlencode({"amenity": "golf course", "format": "jsonv2", "limit": 40, "viewbox": f"{lon-0.5},{lat+0.5},{lon+0.5},{lat-0.5}", "bounded": 1}))
print("\n## amenity= status", st, "count", len(d) if isinstance(d, list) else d)
# Overpass around: status + CORS headers, GET and POST
q = f'[out:json][timeout:25];(way["leisure"="golf_course"](around:25000,{lat},{lon});relation["leisure"="golf_course"](around:25000,{lat},{lon}););out tags center bb;'
for srv in ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]:
    st, h, d = get(srv + "?" + urllib.parse.urlencode({"data": q}))
    print(f"\n## overpass GET {srv} status {st} CORS {h.get('Access-Control-Allow-Origin')} count {len(d['elements']) if isinstance(d, dict) else d}")
