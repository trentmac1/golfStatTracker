# Building the tracker (Phase 2)

What you end up with: the XIAO nRF52840 Sense on the L76K GNSS board, a LiPo on the XIAO's battery pads, and a button on D3. It talks to the app over Bluetooth, in the Bluefy browser on your iPhone.

Do the steps in order. Each one checks the last before you solder anything you can't easily undo.

## You need

- Seeed XIAO nRF52840 **Sense** and the L76K GNSS Module for XIAO (with its antenna)
- LiPo cell, 3.7 V, 1100 mAh for now (400–500 mAh later)
- Small tactile button and two short thin wires
- USB-C **data** cable (some cables only charge) and a Mac or PC
- Soldering iron, solder, a multimeter, and tape or heat-shrink
- On the iPhone: **Bluefy – Web BLE Browser** from the App Store (free)

## 1. Flash the firmware (XIAO on its own)

1. On the computer, download **golf-tracker.uf2** from the repo's [firmware release](https://github.com/trentmac1/golfStatTracker/releases/tag/firmware). It's rebuilt every time the firmware changes.
2. Plug the XIAO in with USB-C.
3. **Double-tap** the tiny reset button next to the USB socket (two quick presses). A drive called **XIAO-SENSE** appears. If it doesn't, try again a little faster or slower.
4. Drag `golf-tracker.uf2` onto that drive. It copies, the drive disappears and the XIAO restarts. A Mac may warn that the disk wasn't ejected properly. That's normal.
5. Check: every 2 seconds the LED gives a short **red** flash. Red means "no GPS data", which is right because the GPS board isn't on yet.

To update the firmware later, repeat steps 3–4. Your settings aren't stored on the tracker yet, so nothing is lost.

## 2. Connect from the phone

1. Open Bluefy and go to `https://trentmac1.github.io/golfStatTracker/`.
2. Go to **Backup → Open tracker → Connect tracker**, pick **Golf Tracker**, and allow Bluetooth.
3. Check: the battery shows (with no cell it reads around 0% or a meaningless voltage; that's fine for now). **Motion** jumps when you twist the board. **Sound** moves when you clap. GPS says **No data**.
4. Tap **Flash the tracker's lights**. The LED blinks white for 3 seconds.

Bluefy keeps its own copy of the app's data, separate from the Home Screen app. Rounds don't move between them by themselves. To bring rounds across, use Export backup in one and Import backup in the other.

## 3. Fit the GPS board

1. Unplug USB.
2. Plug the XIAO into the GNSS board, following the orientation in Seeed's guide (the USB-C end matches the board outline). Seeed warns **not to plug it in backwards**.
3. Clip the antenna onto the U.FL connector: press straight down until it clicks. Put the antenna where it can see the sky.
4. Plug USB back in and go outside. The LED flashes **yellow** while the GPS is talking but has no fix, then **green** once it has a fix. The first fix can take a few minutes with a clear sky. Later fixes are quicker, thanks to the board's backup cell.
5. In the app's Tracker screen, GPS goes from Searching to **Fix**, with a satellite count. Tap **Compare with the phone's GPS**. Standing still in the open, the two should be within about 5 m.

## 4. Check the button pin

The firmware checks the free XIAO pins at power-on and reports any that the GPS board drives. Look at **Checks** on the Tracker screen:
- "Button pin D3: free to use" means go ahead.
- If D3 shows as busy, **don't wire it**. Send me the list of busy pins and I'll move the button.

## 5. Solder the battery

The XIAO has two pads on the **back**, marked **BAT+** and **BAT−**.

1. **Unplug USB.** Never solder with the board powered.
2. **Check the cell's polarity with the multimeter.** Red is usually +, but connector wiring isn't standard. Set the meter to DC volts and touch the probes to the two wires. A reading of about **+3.7 to +4.2 V** means the red probe is on the + wire.
3. Work on **one wire at a time**, so the bare ends can never touch. Cut it, strip about 2 mm, tin it, and solder it: + to **BAT+**, − to **BAT−**. Cover the first joint with tape before doing the second.
4. Check that there are no solder bridges between the pads.
5. Plug USB back in. The XIAO's small charge LED (beside the USB socket) lights while charging. The firmware charges at 100 mA, so an 1100 mAh cell takes about 11 hours from flat.
6. In the app, the battery shows a sensible voltage (3.6–4.2 V) and **charging**.

## 6. Wire the button

1. Unplug USB.
2. A 4-leg tactile button has two pairs of legs that are joined inside. Use two **diagonally opposite** legs, which are always on different sides of the switch.
3. Solder one leg to **D3** and the other to **GND** on the XIAO (or the GNSS board's matching header pins). The firmware turns on D3's internal pull-up resistor, so no resistor is needed.
4. Plug in and check: a short press gives a quick white blink, and **Button presses** counts up in the app. Holding for 2 s toggles **Round** on and off, and the LED double-flashes while a round is on.

## What the LED means

| Every 2 s | Meaning |
|---|---|
| short red flash | no data from the GPS (board not fitted, or backwards) |
| short yellow flash | GPS talking, no fix yet |
| short green flash | GPS fix |
| two flashes | round active (from the app or a 2 s button hold) |
| then a short blue flash | phone connected |
| fast white blinking | "Flash the tracker's lights" from the app |
| short magenta flash | a swing was saved (capture mode, during a round) |
| short white blink | button press counted (and labelled, during a round) |

The separate charge LED by the USB socket is wired to the charger, not the firmware.

**While starting up** (the first second or two), the LED shows which step is running. If it stays on one colour, that step has hung:

| Stuck on | Step | What to check |
|---|---|---|
| red | USB, battery, GPS lines, pin check | unplug the GPS board and button, then try again |
| green | Bluetooth | open `INFO_UF2.TXT` on the XIAO-SENSE drive (double-tap reset): it should say `SoftDevice: S140 7.3.0` |
| blue | motion sensor | send me the serial log |
| yellow | microphone | send me the serial log |
| magenta | flash storage (capture log) | send me the serial log |

## Optional: the serial log

With USB connected, any serial monitor at 115200 baud (the Arduino IDE's, or a Web Serial terminal in Chrome) prints a status line every second: battery, GPS, IMU, mic, button and Bluetooth. Type `n` to see the raw GPS sentences, `p` to re-run the pin check, and `h` for help. It's handy if something on the Tracker screen looks wrong.

## Phase 2 checklist

Phase 2 is done when the app shows live battery, GPS fix and satellite count from the tracker in Bluefy. Please check these and send me the results (a screenshot of the Tracker screen is ideal):

1. [ ] Firmware flashed: the LED flashes red with the XIAO on its own.
2. [ ] Bluefy connects, Motion and Sound react, and Flash the tracker's lights works.
3. [ ] With the GPS board on, outside: a fix within about 5 minutes. Note the satellite count and HDOP.
4. [ ] Tracker vs phone position after a minute standing still: ___ m apart.
5. [ ] Pin check: which pins are listed as in use? Is D3 free?
6. [ ] Battery soldered: voltage ___ V, "charging" shows on USB and clears when unplugged.
7. [ ] Button: presses count, and a 2 s hold toggles Round.
8. [ ] Range: walk away with the phone. How far until the connection drops? Does Reconnect work when you walk back?
9. [ ] Battery life: leave it running, unplugged, with the GPS fixed (the Tracker screen can stay closed). How many hours until it dies? This gives the baseline before power saving.

Anything odd (no data from the GPS, IMU not found, the mic not working, Bluefy not finding the tracker): send the Tracker screen or the serial log.

## Phase 3: collecting training data

Firmware 0.2.0 adds capture mode. While a round is on, the tracker saves every swing candidate to its 2 MB flash: 2 s of motion data (208 samples a second, 1.5 s before the peak rotation and 0.5 s after) and the microphone's level over the same 2 s. A short button press after a real shot saves a label. The app syncs the log over Bluetooth and exports it as JSON for the Phase 4 notebook. Format: [ble-protocol.md](ble-protocol.md), "Capture log".

### Update the firmware

Same as step 1: download **golf-tracker.uf2** from the firmware release, double-tap reset, drag it onto XIAO-SENSE. The Tracker screen should show firmware 0.2.0. The first start-up after updating sets up a new, empty log.

### A session

1. Tracker in your **front trouser pocket**, antenna side towards your body's outside, the same way every session.
2. **Start a round**: hold the button 2 s (the LED double-flashes every 2 s), or tap Round on the app's **Training data** screen.
3. Hit balls as normal. A short **magenta** flash means a swing was saved. Practice swings, waggles and the odd walk will be saved too. That's fine: the detector learns what to ignore from them.
4. After each **real shot**, once the follow-through is done, one short press of the button (white blink), **2–5 s after the shot**. Nothing for practice swings. Reaching for the button saves a snippet of its own; the app tags those "Button press". It labels the latest swing 1.5–8 s before the press, so press neither straight away nor late. A press with no swing in that window is recorded as a shot the trigger missed.
5. **End the round** (hold 2 s).
6. In Bluefy: **Backup → Training data → Sync**, then **Export training data (JSON)** and save it to Files. Then **Clear the tracker's storage** (it only clears once everything is synced; the phone keeps its copy).

The tracker holds about 290 swings, so sync after each session. If it fills up, swings stop being saved (the app shows "full") until it's cleared.

**Range and Round mode** (firmware 0.3.0). On the Training data screen, **Range** saves every swing that reaches the trigger: practice swings and chips included, for the range. **Round** sets the trigger to 250 °/s and saves a swing only if it looks like one: an impact heard at the strike, rotation that builds up through the downswing (firmware 0.3.1; a knock or a bump goes from still to its peak in a few milliseconds), no button press at the same moment, and standing still for a moment before the swing (firmware 0.3.2; you're still at address before every shot, while most knocks happen while you're moving). So walking, knocks and reaching for the button don't fill the tracker (in testing: all full shots kept, walking down from about 16 saved a minute to under 1). Chips and putts are usually too quiet to be heard from the pocket, so in Round mode press the button 2–5 s after each one: the press is saved with its time and GPS position. The mode, trigger and impact level stay on the tracker when it restarts. On a full round, sync and clear at the turn if storage is over half full.

**Swing trigger.** A swing is saved when the rotation reaches the trigger. Full swings from the pocket peak at about 340–1150 °/s and chips at about 200, so use 250 for full swings and 150 for chips and pitches. The app shows each swing's peak. If chips or short pitches aren't being saved, lower it in steps of 10; if walking fills the log, raise it. It resets to 150 when the tracker restarts.

### Phase 3 checklist

Phase 3 is done after at least **2 range sessions and 2 rounds** of labelled data. First, a quick check at home or the range:

1. [ ] Firmware 0.2.0 on the Tracker screen, and Training data shows the tracker's storage (about 0% used).
2. [ ] Round on: 10 full practice swings give 10 magenta flashes, and the app shows 10 swings saved.
3. [ ] A few chips: are they saved? Note the trigger if you had to lower it.
4. [ ] Button presses after swings: Sync, open the session, and the right swings say **Shot**.
5. [ ] Hitting real balls: swings show "impact +x ms" near 0, practice swings show "no impact heard". (If every swing says no impact, the pocket may be muffling the mic; tell me.)
6. [ ] Export the JSON and check it saved to Files. Then clear the tracker.
7. [ ] Battery after a 2-hour range session: ___ %.

Then the sessions themselves: send me each exported JSON file (or tell me where they are) with a line on what you did: range or course, roughly how many balls, clubs used, anything odd.
