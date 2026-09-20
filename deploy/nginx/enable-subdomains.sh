#!/usr/bin/env bash
# Serve ai.projxenios.trade and bot.projxenios.trade from the same nginx site as
# projxenios.trade. One frontend build, one backend (127.0.0.1:3001); the browser
# picks the workspace from the hostname (see src/lib/appMode.js).
#
# Needs root (edits /etc/nginx, expands the Let's Encrypt cert). Idempotent.
#   sudo bash deploy/nginx/enable-subdomains.sh
#
# Cloudflare currently answers 526 for both names because the origin cert only
# covers projxenios.trade; expanding the cert is what fixes that.
set -euo pipefail

CONF=/etc/nginx/sites-available/xeniostrade
DOMAIN=projxenios.trade
NAMES=(ai bot)

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash $0" >&2; exit 1; }
[ -f "$CONF" ] || { echo "Missing $CONF" >&2; exit 1; }

changed=0
for sub in "${NAMES[@]}"; do
  if ! grep -q "${sub}\.${DOMAIN}" "$CONF"; then
    [ "$changed" -eq 0 ] && cp -a "$CONF" "$CONF.bak-$(date +%Y%m%d-%H%M%S)"
    # Append to every `server_name projxenios.trade ...;` line (443 and 80 blocks).
    sed -i -E "s/^([[:space:]]*server_name[[:space:]]+${DOMAIN//./\\.}[^;]*);/\1 ${sub}.${DOMAIN};/" "$CONF"
    changed=1
  fi
done
[ "$changed" -eq 1 ] && echo "Added ai./bot. to server_name in $CONF" || echo "server_name already lists ai./bot."

nginx -t
systemctl reload nginx

# Add the two names to the existing certificate (keeps /etc/letsencrypt/live/$DOMAIN/).
certbot --nginx --expand --cert-name "$DOMAIN" \
  -d "$DOMAIN" -d "ai.${DOMAIN}" -d "bot.${DOMAIN}" \
  --non-interactive

nginx -t
systemctl reload nginx

echo
echo "Check:"
for sub in ai bot; do
  printf '  %s.%s -> ' "$sub" "$DOMAIN"
  curl -s -o /dev/null -w '%{http_code}\n' "https://${sub}.${DOMAIN}/"
done
