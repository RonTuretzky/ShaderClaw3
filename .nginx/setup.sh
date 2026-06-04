#!/usr/bin/env bash
# Generate nginx config + self-signed SSL cert for local HTTPS
# Required for WebXR on Vision Pro Safari
#
# Usage:
#   ./.nginx/setup.sh
#   nginx -c $(pwd)/.nginx/nginx.generated.conf
#   # Then open https://<your-ip>:8443 on Vision Pro Safari

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Locate mime.types ──
MIME_PATHS=(
  "/opt/homebrew/etc/nginx/mime.types"
  "/usr/local/etc/nginx/mime.types"
  "/etc/nginx/mime.types"
)
MIME_TYPES_PATH=""
for p in "${MIME_PATHS[@]}"; do
  if [ -f "$p" ]; then
    MIME_TYPES_PATH="$p"
    break
  fi
done
if [ -z "$MIME_TYPES_PATH" ]; then
  echo "ERROR: Could not find nginx mime.types. Install nginx first:"
  echo "  brew install nginx"
  exit 1
fi
echo "Found mime.types: $MIME_TYPES_PATH"

# ── Generate self-signed certificate ──
if [ ! -f "$SCRIPT_DIR/cert.pem" ] || [ ! -f "$SCRIPT_DIR/key.pem" ]; then
  echo "Generating self-signed SSL certificate..."
  openssl req -x509 -newkey rsa:2048 \
    -keyout "$SCRIPT_DIR/key.pem" \
    -out "$SCRIPT_DIR/cert.pem" \
    -days 365 -nodes \
    -subj "/CN=localhost" \
    2>/dev/null
  echo "Certificate created."
else
  echo "SSL certificate already exists, skipping generation."
fi

# ── Generate nginx config from template ──
sed \
  -e "s|NGINX_DIR|$SCRIPT_DIR|g" \
  -e "s|PROJECT_ROOT|$PROJECT_ROOT|g" \
  -e "s|MIME_TYPES_PATH|$MIME_TYPES_PATH|g" \
  "$SCRIPT_DIR/nginx.conf" > "$SCRIPT_DIR/nginx.generated.conf"

echo "Generated: .nginx/nginx.generated.conf"

# ── Detect LAN IP ──
LOCAL_IP=$(ifconfig 2>/dev/null | grep "inet " | grep -v 127.0.0.1 | grep -v "\-\->" | awk '{print $2}' | head -1)
if [ -z "$LOCAL_IP" ]; then
  LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<your-ip>")
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Start the servers:"
echo "  npm start                                          # Node.js on :7778"
echo "  nginx -c $SCRIPT_DIR/nginx.generated.conf   # nginx HTTPS on :8443"
echo ""
echo "Access from Vision Pro Safari:"
echo "  https://$LOCAL_IP:8443"
echo ""
echo "To stop nginx:"
echo "  nginx -s stop -c $SCRIPT_DIR/nginx.generated.conf"
