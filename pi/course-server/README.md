# Course server (Raspberry Pi)

Shares green, tee, front/back, par and stroke-index edits between everyone using the app. Edits go live as soon as they arrive. There are no accounts and nothing to approve. Each phone keeps working offline and catches up the next time it updates.

What's shared: positions people placed by hand (on the course map, by dragging the flag or by tapping On green) and pars and stroke indexes typed in. What's **not** shared: rounds, shots, ratings, slopes, hole lengths, and anything from GolfCourseAPI lookups (its terms don't allow passing it on). Green outlines and slopes aren't shared either; each phone gets them from OpenStreetMap and the Queensland height data.

Merge rule: the newest edit to a field wins, except that a rough green (from the first ball on the green) never replaces one somebody placed properly. Rules: `webapp/js/coursemerge.js`, used by both the app and this server.

## Set it up

You need Raspberry Pi OS (Bookworm or newer) and about 10 minutes.

### 1. Get the code and Node

```sh
sudo apt update && sudo apt install -y git nodejs
node --version          # needs 18 or newer
git clone https://github.com/trentmac1/golfStatTracker.git
cd golfStatTracker
sh pi/course-server/install.sh
```

The last line installs it as a service called `golf-courses` that starts when the Pi boots. It should finish with `{"ok":true,"courses":0}` and "Course server is running." Course data lives in `~/golf-courses`.

### 2. Put it on the internet with HTTPS (Tailscale Funnel, free)

The app runs from an `https://` page, so the server needs an `https://` address too. Tailscale Funnel gives the Pi a fixed one, with no domain or router changes needed.

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                 # opens a sign-in link: sign up free and approve the Pi
sudo tailscale funnel --bg --https=8443 8787
```

This uses public port 8443, so it sits alongside anything you already serve on the normal port (443). Running `tailscale funnel --bg 8787` without `--https=8443` would replace whatever is already on 443. Funnel allows ports 443, 8443 and 10000, so a Pi can have up to three. `sudo tailscale funnel status` lists them all.

The first time, `tailscale funnel` prints a link to switch on HTTPS and Funnel for your account. Open it, approve, then run the command again. It then shows the address, something like:

```
https://raspberrypi.tail1234.ts.net:8443
```

Check it from your phone (on mobile data, to be sure it's public): open `https://raspberrypi.tail1234.ts.net:8443/api/health`. You should see `{"ok":true,...}`.

To stop it later: `sudo tailscale funnel --https=8443 off`.

### 3. Tell the app

Send me the address and I'll build it into the app, so every user gets it automatically. Until then you can test it on your own phone: **Backup → Shared courses → Course server**, paste the address and tap Save.

## Day to day

- **Update courses** (Backup tab) sends your edits for every course and brings in everyone else's.
- **Update green and tee locations** (on a course's screen, under Place greens on the map) does the same for one course.
- Leaving the map editor sends what you placed straight away, if there's signal.
- Adding a course from the map brings in what others have shared for it.

## Looking after it

```sh
sudo systemctl status golf-courses       # running?
journalctl -u golf-courses -n 50         # recent log
cd ~/golfStatTracker && git pull && sudo systemctl restart golf-courses   # update
```

**Undo a bad edit:** every version of every course is kept.

```sh
cd ~/golfStatTracker
node pi/course-server/restore.mjs                 # list courses
node pi/course-server/restore.mjs keperra         # its versions, and what changed in each
node pi/course-server/restore.mjs keperra 4       # make version 4 current again
sudo systemctl restart golf-courses
```

Phones pick up the restored version the next time they update.

**Backups:** copy `~/golf-courses` somewhere now and then. It's small.

## Limits and protection

- Requests are only accepted from the app's own address (`https://trentmac1.github.io`).
- Positions more than 6 km from the course are refused, as are pars outside 3–6 and stroke indexes outside the hole count.
- Each address can send 120 updates an hour. One Update courses press is one update per course with changes.
- Anyone using the app can edit. If that becomes a problem, the history makes it easy to undo, and a club code can be added later.

Settings live in `/etc/systemd/system/golf-courses.service`: `PORT`, `DATA_DIR`, `ALLOW_ORIGINS` and `WRITES_PER_HOUR`. After changing them, run `sudo systemctl daemon-reload && sudo systemctl restart golf-courses`.
