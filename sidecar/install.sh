#!/usr/bin/env bash
# File Steward sidecar installer for Linux + systemd.
#
#   sudo bash install.sh              install or upgrade (asks before anything it can't detect)
#   sudo bash install.sh --uninstall  stop and remove the service (keeps trash, config and token)
#
# Optional overrides (skip detection/prompts):
#   FS_USERDATA=/path/to/foundrydata  Foundry's User Data Path (the folder that contains Data/)
#   FS_USER=foundry                   Linux user Foundry runs as
#   FS_PORT=30013                     local port for the sidecar
#
# It never edits your reverse proxy. It prints the lines to add.
set -euo pipefail

RELEASE_URL="https://github.com/fisherkyng-svg/file-steward/releases/latest/download"
INSTALL_DIR="/opt/file-steward-sidecar"
CONF_DIR="/etc/file-steward"
UNIT="/etc/systemd/system/file-steward.service"
PORT="${FS_PORT:-30013}"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo: sudo bash $0"
command -v systemctl >/dev/null || die "systemd is required."

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl disable --now file-steward 2>/dev/null || true
  rm -f "$UNIT" && systemctl daemon-reload
  rm -rf "$INSTALL_DIR"
  say "File Steward sidecar removed. Kept: $CONF_DIR (config, token) and the trash folder."
  exit 0
fi

# ---------- Node ----------
NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  # Foundry may run on a node that isn't on root's PATH (nvm etc.): take it from the running process.
  NODE="$(ps -eo args= | awk '/(main\.mjs|main\.js|resources\/app)/ && /node/ {print $1; exit}')"
fi
[[ -x "${NODE:-}" ]] || die "Couldn't find node. Install Node 18+ (Foundry needs it too) and run again."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 18 )) || die "Node $NODE_MAJOR found at $NODE; File Steward needs 18 or newer."

# ---------- Foundry user data path ----------
detect_userdata() {
  local p
  # 1) a running Foundry process
  p="$(ps -eo args= | grep -oE -- '--dataPath[= ][^ ]+' | head -1 | sed -E 's/--dataPath[= ]//')" || true
  [[ -n "$p" && -d "$p/Data" ]] && { echo "$p"; return; }
  # 2) systemd units
  p="$(grep -rhoE -- '--dataPath[= ][^ "]+' /etc/systemd/system 2>/dev/null | head -1 | sed -E 's/--dataPath[= ]//')" || true
  [[ -n "$p" && -d "$p/Data" ]] && { echo "$p"; return; }
  # 3) usual places
  for p in /home/*/foundrydata /home/*/.local/share/FoundryVTT /opt/foundrydata /var/foundrydata /srv/foundrydata /data/foundrydata; do
    [[ -d "$p/Data" ]] && { echo "$p"; return; }
  done
}

USERDATA="${FS_USERDATA:-$(detect_userdata || true)}"
if [[ -z "$USERDATA" ]]; then
  read -r -p "Foundry User Data Path (the folder that contains Data/; Setup → Configuration shows it): " USERDATA
elif [[ -z "${FS_USERDATA:-}" && -t 0 ]]; then
  read -r -p "Foundry User Data Path [$USERDATA]: " ans
  USERDATA="${ans:-$USERDATA}"
fi
USERDATA="$(realpath "$USERDATA")"
[[ -d "$USERDATA/Data" ]] || die "$USERDATA/Data doesn't exist. Check the path and run again."
DATA="$USERDATA/Data"
TRASH="$USERDATA/FileStewardTrash"

FUSER="${FS_USER:-$(stat -c %U "$DATA")}"
id "$FUSER" >/dev/null 2>&1 || die "User $FUSER doesn't exist."
[[ "$FUSER" != "root" ]] || warn "Foundry's Data folder is owned by root. The sidecar will run as root; consider running Foundry as its own user."

ROUTE_PREFIX=""
if [[ -f "$USERDATA/Config/options.json" ]]; then
  ROUTE_PREFIX="$("$NODE" -e 'try{const o=require(process.argv[1]);process.stdout.write((o.routePrefix||"").replace(/^\/+|\/+$/g,""))}catch{}' "$USERDATA/Config/options.json")"
fi
API_PATH="/${ROUTE_PREFIX:+$ROUTE_PREFIX/}file-steward/api"

say "Installing File Steward sidecar"
echo "  Data folder:   $DATA"
echo "  Trash folder:  $TRASH"
echo "  Runs as:       $FUSER"
echo "  Node:          $NODE (v$("$NODE" -v | tr -d v))"
echo "  Listens on:    127.0.0.1:$PORT"

# ---------- files ----------
mkdir -p "$INSTALL_DIR"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HERE/server.mjs" ]]; then
  install -m 0644 "$HERE/server.mjs" "$INSTALL_DIR/server.mjs"
else
  command -v curl >/dev/null || die "server.mjs isn't next to this script and curl isn't installed."
  curl -fsSL "$RELEASE_URL/server.mjs" -o "$INSTALL_DIR/server.mjs"
fi

mkdir -p "$CONF_DIR" "$TRASH"
chown "$FUSER": "$CONF_DIR" "$TRASH"
chmod 0700 "$CONF_DIR"
if [[ ! -f "$CONF_DIR/file-steward.json" ]]; then
  cat > "$CONF_DIR/file-steward.json" <<JSON
{
  "userDataPath": "$USERDATA",
  "trashPath": "$TRASH",
  "port": $PORT,
  "host": "127.0.0.1",
  "allowedRoots": ["*"],
  "retentionDays": null
}
JSON
  chown "$FUSER": "$CONF_DIR/file-steward.json"
  chmod 0600 "$CONF_DIR/file-steward.json"
else
  echo "  Keeping existing config: $CONF_DIR/file-steward.json"
fi

TOKEN="$(sudo -u "$FUSER" env FILE_STEWARD_CONFIG="$CONF_DIR/file-steward.json" "$NODE" "$INSTALL_DIR/server.mjs" --print-token | tail -1)"

# ---------- service ----------
cat > "$UNIT" <<UNITFILE
[Unit]
Description=File Steward sidecar for Foundry VTT
After=network.target

[Service]
User=$FUSER
Environment=FILE_STEWARD_CONFIG=$CONF_DIR/file-steward.json
ExecStart=$NODE $INSTALL_DIR/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$DATA $TRASH $CONF_DIR
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
UNITFILE

systemctl daemon-reload
systemctl enable file-steward >/dev/null 2>&1
systemctl restart file-steward
sleep 1.5
if ! systemctl is-active --quiet file-steward; then
  journalctl -u file-steward -n 20 --no-pager || true
  die "The service didn't start; the log is above."
fi
PING="$(curl -fsS "http://127.0.0.1:$PORT/ping" 2>/dev/null || true)"
[[ "$PING" == *'"service":"file-steward"'* ]] || die "Service is running but didn't answer on port $PORT."
say "Sidecar is running."

# ---------- proxy instructions ----------
echo
say "1) Add one route to your reverse proxy (this installer doesn't touch it):"
if systemctl is-active --quiet caddy 2>/dev/null; then
  echo "   Caddy detected. In your site block (e.g. /etc/caddy/Caddyfile), add above the Foundry reverse_proxy line:"
  echo
  echo "       reverse_proxy $API_PATH/* 127.0.0.1:$PORT"
  echo
  echo "   Then: sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy"
elif systemctl is-active --quiet nginx 2>/dev/null; then
  echo "   nginx detected. Inside your Foundry server { } block, add:"
  echo
  echo "       location $API_PATH/ {"
  echo "           proxy_pass http://127.0.0.1:$PORT;"
  echo "           proxy_set_header X-Real-IP \$remote_addr;"
  echo "       }"
  echo
  echo "   Then: sudo nginx -t && sudo systemctl reload nginx"
else
  echo "   No Caddy or nginx found running. Route $API_PATH/* to http://127.0.0.1:$PORT in your proxy,"
  echo "   or see the README for running without a proxy."
fi

echo
say "2) In Foundry: Configure Settings → File Steward → paste this token into \"Server helper token\":"
echo
echo "       $TOKEN"
echo
echo "   (Shown again any time with: sudo -u $FUSER env FILE_STEWARD_CONFIG=$CONF_DIR/file-steward.json $NODE $INSTALL_DIR/server.mjs --print-token)"
echo
echo "Trash keeps files until you empty it. To purge automatically, set \"retentionDays\" in $CONF_DIR/file-steward.json and run: sudo systemctl restart file-steward"
