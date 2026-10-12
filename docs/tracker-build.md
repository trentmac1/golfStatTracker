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

The separate charge LED by the USB socket is wired to the charger, not the firmware.

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
