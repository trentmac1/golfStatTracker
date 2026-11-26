"""Chip and putt detection from a practice recording (27 Nov 2026).

Feeds the recording in a training-data export (version 8) through the
firmware's detector (firmware/src/stroke.cpp, built for the host) and scores
the app's rules (webapp/js/shortgame.js, STROKE) against the button labels:
one press after a putt, a double press after a chip.

    python3 analysis/shortgame/strokes.py golf-tracker-capture.json

A stroke counts as found when a candidate passing the rules has its peak
1.1-5 s before a press. The press itself (hand into the pocket) comes in the
last second, so that's left out. Prints found / missed / false per session
and whether each found stroke was typed right.
"""
import json, struct, subprocess, sys, os, tempfile, csv
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FW = os.path.join(HERE, '..', '..', 'firmware')

# The app's rules (keep in step with webapp/js/shortgame.js).
STROKE = dict(peak=18, area=10, pre=8, dur_lo=250, dur_hi=1200, peak_max=150, gap_ms=3000,
              chip_sound=11, chip_peak=50)

def build():
    exe = os.path.join(tempfile.gettempdir(), 'replay_strokes')
    subprocess.check_call(['g++', '-O2', '-std=c++17', '-o', exe,
                           os.path.join(FW, 'test', 'host', 'replay_strokes.cpp'), os.path.join(FW, 'src', 'stroke.cpp')])
    return exe

def rows_for(rec):
    raw = np.array(rec['imu']['raw'], dtype=np.int16)
    hz = rec['imu']['rate_hz']
    hi = np.array(rec['sound']['high'], dtype=np.uint8)
    lo = np.array(rec['sound']['low'], dtype=np.uint8)
    blocks = rec['blocks']
    out = bytearray(); t = []
    per = blocks[0]['samples']; bins = blocks[0]['bins']
    for bi, b in enumerate(blocks):
        dur = per * 1000 / hz
        for j in range(per):
            i = bi * per + j
            # sound bins overlapping this sample
            s0 = int(j * bins / per); s1 = max(s0 + 1, int(np.ceil((j + 1) * bins / per)))
            h = hi[bi * bins + s0: bi * bins + s1].max(); l = lo[bi * bins + s0: bi * bins + s1].max()
            ts = b['device_ms'] + j * dur / per
            out += struct.pack('<6hBBxxf', *raw[i], int(h), int(l), ts)
    return bytes(out), hz

def candidates(exe, rec):
    data, hz = rows_for(rec)
    with tempfile.NamedTemporaryFile(delete=False) as f:
        f.write(data)
    res = subprocess.run([exe, f.name, str(hz)], capture_output=True, text=True, check=True).stdout
    os.unlink(f.name)
    return [{k: float(v) for k, v in r.items()} for r in csv.DictReader(res.splitlines())]

def strokes(cands, R=STROKE):
    ok = [c for c in cands if c['peak'] >= R['peak'] and c['area'] >= R['area'] and c['pre'] <= R['pre']
          and R['dur_lo'] <= c['dur_ms'] <= R['dur_hi'] and c['peak'] <= R['peak_max']]
    ok.sort(key=lambda c: -c['peak']); kept = []
    for c in ok:
        if all(abs(c['t_ms'] - k['t_ms']) > R['gap_ms'] for k in kept): kept.append(c)
    for c in kept:
        c['kind'] = 'chip' if (c['high'] >= R['chip_sound'] if c['high'] > 0 else c['peak'] >= R['chip_peak']) else 'putt'
    return sorted(kept, key=lambda c: c['t_ms'])

def score(found, labels):
    used = {}; false = []
    for c in found:
        m = [i for i, l in enumerate(labels) if i not in used and -5000 <= c['t_ms'] - l['device_ms'] <= -1100]
        if m: used[m[0]] = c
        else: false.append(c)
    right = sum(1 for i, c in used.items() if c['kind'] == labels[i]['stroke'])
    return len(used), len(labels), len(false), right

def main(path):
    exe = build()
    ex = json.load(open(path))
    for L in ex['logs']:
        for s in L['sessions']:
            rec = s.get('recording')
            if not rec or not rec['blocks']: continue
            labels = [l for l in s['labels'] if l.get('stroke')]
            cands = candidates(exe, rec)
            found = strokes(cands)
            n, tot, nf, right = score(found, labels)
            mins = len(rec['blocks']) * rec['blocks'][0]['samples'] / rec['imu']['rate_hz'] / 60
            print(f"{L['logId']} {s['start']}: {mins:.1f} min, {len(cands)} candidates from the tracker, "
                  f"{n}/{tot} strokes found, {nf} false, {right}/{n} typed right")

if __name__ == '__main__':
    main(sys.argv[1])
