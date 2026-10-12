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
#   FS_NODE=/path/to/node             the node binary to use
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

# ---------- Find the running Foundry (host process or Docker) ----------
FPID=""
for pid in $(pgrep -f -- 'main\.(m)?js' || true); do
  # only a real node process counts (not a shell whose command line merely mentions main.js)
  [[ "$(readlink -f "/proc/$pid/exe" 2>/dev/null)" == *node* ]] || continue
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qE 'resources/app/main|foundry|--dataPath' && { FPID="$pid"; break; }
done
DOCKER_ID=""
if command -v docker >/dev/null 2>&1; then
  DOCKER_ID="$(docker ps --format '{{.ID}} {{.Image}} {{.Names}}' 2>/dev/null | grep -i foundry | head -1 | cut -d' ' -f1 || true)"
  # A containerized Foundry's node isn't usable from the host.
  [[ -n "$DOCKER_ID" ]] && FPID=""
fi

# ---------- Node ----------
NODE="${FS_NODE:-}"
# 1) the exact node binary Foundry is running on (works for nvm, /usr/local, anything)
if [[ -z "$NODE" && -n "$FPID" ]]; then
  exe="$(readlink -f "/proc/$FPID/exe" 2>/dev/null || true)"
  [[ "$exe" == *node* && -x "$exe" ]] && NODE="$exe"
fi
# 2) PATH, then common install locations (newest nvm version first)
[[ -z "$NODE" ]] && NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  for n in /usr/local/bin/node /usr/bin/node $(ls -d /home/*/.nvm/versions/node/*/bin/node /root/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V -r) /opt/*/bin/node; do
    [[ -x "$n" ]] && { NODE="$n"; break; }
  done
fi
if [[ -z "$NODE" ]]; then
  if [[ -n "$DOCKER_ID" ]]; then
    warn "Foundry is running in Docker (container $DOCKER_ID), so Node isn't on the host."
    echo "Its data volume mounts are:" >&2
    docker inspect -f '{{range .Mounts}}  {{.Source}} -> {{.Destination}}{{println}}{{end}}' "$DOCKER_ID" >&2 || true
    die "Install Node on the host (Ubuntu 24.04: sudo apt install -y nodejs) and rerun with FS_USERDATA=<host folder that contains Data/>."
  fi
  die "Couldn't find node. Install it (Ubuntu 24.04: sudo apt install -y nodejs) or rerun with FS_NODE=/path/to/node."
fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 18 )) || die "Node $NODE_MAJOR found at $NODE; File Steward needs 18 or newer."

# ---------- Foundry user data path ----------
detect_userdata() {
  local p
  # 0) Foundry in Docker: the host folder mounted where the container keeps its data (felddy image: /data)
  if [[ -n "$DOCKER_ID" ]]; then
    p="$(docker inspect -f '{{range .Mounts}}{{.Source}}|{{.Destination}}{{println}}{{end}}' "$DOCKER_ID" 2>/dev/null \
         | while IFS='|' read -r src _; do [[ -d "$src/Data" ]] && { echo "$src"; break; }; done)" || true
    [[ -n "$p" ]] && { echo "$p"; return; }
  fi
  # 1) the running Foundry process's own command line
  if [[ -n "$FPID" ]]; then
    p="$(tr '\0' ' ' < "/proc/$FPID/cmdline" | grep -oE -- '--dataPath[= ][^ ]+' | head -1 | sed -E 's/--dataPath[= ]//')" || true
    [[ -n "$p" && -d "$p/Data" ]] && { echo "$p"; return; }
  fi
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
[[ -n "$DOCKER_ID" ]] && say "Foundry is running in Docker (container $DOCKER_ID); using the host folder mounted into it."
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
if [[ "$FUSER" == "UNKNOWN" ]] || ! id "$FUSER" >/dev/null 2>&1; then
  FUSER="$(stat -c %u "$DATA")"   # a uid with no host account (common with Docker); systemd and sudo accept "#uid"
  warn "Data is owned by uid $FUSER with no matching user on this host; the sidecar will run as that uid."
fi
SUDO_AS="$FUSER"; [[ "$FUSER" =~ ^[0-9]+$ ]] && SUDO_AS="#$FUSER"
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
chown "$FUSER" "$CONF_DIR" "$TRASH"
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
  chown "$FUSER" "$CONF_DIR/file-steward.json"
  chmod 0600 "$CONF_DIR/file-steward.json"
else
  echo "  Keeping existing config: $CONF_DIR/file-steward.json"
fi

TOKEN="$(sudo -u "$SUDO_AS" env FILE_STEWARD_CONFIG="$CONF_DIR/file-steward.json" "$NODE" "$INSTALL_DIR/server.mjs" --print-token | tail -1)"

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
echo "   (Shown again any time with: sudo -u $SUDO_AS env FILE_STEWARD_CONFIG=$CONF_DIR/file-steward.json $NODE $INSTALL_DIR/server.mjs --print-token)"
echo
echo "Trash keeps files until you empty it. To purge automatically, set \"retentionDays\" in $CONF_DIR/file-steward.json and run: sudo systemctl restart file-steward"
