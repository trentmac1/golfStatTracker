#!/bin/sh
# Install the course server as a service that starts with the Pi.
# Run from the repo folder:  sh pi/course-server/install.sh
set -e
REPO=$(cd "$(dirname "$0")/../.." && pwd)
NODE=$(command -v node || true)
if [ -z "$NODE" ]; then echo "Node.js isn't installed. Run: sudo apt install -y nodejs"; exit 1; fi
MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 18 ]; then echo "Node $MAJOR is too old; version 18 or newer is needed."; exit 1; fi
sudo tee /etc/systemd/system/golf-courses.service >/dev/null <<UNIT
[Unit]
Description=Golf Tracker course server
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$REPO
Environment=PORT=8787
Environment=DATA_DIR=$HOME/golf-courses
Environment=ALLOW_ORIGINS=https://trentmac1.github.io
ExecStart=$NODE $REPO/pi/course-server/server.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now golf-courses
sleep 1
curl -fsS http://127.0.0.1:8787/api/health && echo && echo "Course server is running."
