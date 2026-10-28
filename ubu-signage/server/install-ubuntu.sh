#!/usr/bin/env bash
# Install UBU Signage server as a systemd service on Ubuntu/Debian (incl. Raspberry Pi OS).
# Usage: sudo ADMIN_PASS=yourpassword ./install-ubuntu.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo"; exit 1; fi
APP_DIR=/opt/ubu-signage
DATA_DIR=/var/lib/ubu-signage
PORT="${PORT:-3000}"
ADMIN_PASS="${ADMIN_PASS:-}"
if [ -z "$ADMIN_PASS" ]; then read -rsp "ตั้งรหัสผ่าน admin: " ADMIN_PASS; echo; fi

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "Installing Node.js 20..."
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

SRC="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$APP_DIR" "$DATA_DIR"
cp -r "$SRC/server.js" "$SRC/package.json" "$SRC/package-lock.json" "$SRC/public" "$APP_DIR/"
cd "$APP_DIR" && npm ci --omit=dev

id ubusignage >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin ubusignage
chown -R ubusignage: "$DATA_DIR"

cat > /etc/systemd/system/ubu-signage.service <<UNIT
[Unit]
Description=UBU Signage server
After=network.target

[Service]
User=ubusignage
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=DATA_DIR=$DATA_DIR
Environment=ADMIN_PASS=$ADMIN_PASS
Environment=TZ=Asia/Bangkok
ExecStart=/usr/bin/env node $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
chmod 600 /etc/systemd/system/ubu-signage.service

systemctl daemon-reload
systemctl enable --now ubu-signage
IP=$(hostname -I | awk '{print $1}')
echo
echo "ติดตั้งเสร็จ: http://$IP:$PORT/admin  (user: admin)"
echo "ในแอป Android ใส่: http://$IP:$PORT"
