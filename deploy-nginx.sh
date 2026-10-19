#!/usr/bin/env bash
# Nginx + TLS setup for registration.crushworldseries.com
# Run with: sudo bash /home/greg/apps/se-registration/deploy-nginx.sh
set -euo pipefail

APP_DIR=/home/greg/apps/se-registration
DOMAIN=registration.crushworldseries.com
EMAIL=chris@trudiagnostic.com

if [[ $EUID -ne 0 ]]; then
  echo "Must run as root: sudo bash $0" >&2
  exit 1
fi

echo "==> Installing site config"
cp "$APP_DIR/nginx-se-registration.conf" /etc/nginx/sites-available/se-registration
ln -sf /etc/nginx/sites-available/se-registration /etc/nginx/sites-enabled/se-registration

echo "==> Testing config"
nginx -t

echo "==> Reloading nginx"
systemctl reload nginx

# The apt certbot on this box is broken (python3-openssl too old for the
# installed cryptography); the snap build ships its own python.
CERTBOT=certbot
if ! certbot --version >/dev/null 2>&1; then
  if [[ -x /snap/bin/certbot ]]; then CERTBOT=/snap/bin/certbot
  else
    echo "==> apt certbot is broken; installing the snap build"
    snap install core && snap refresh core
    snap install --classic certbot
    CERTBOT=/snap/bin/certbot
  fi
fi

echo "==> Requesting certificate (certbot will edit the config for HTTPS)"
"$CERTBOT" --nginx -d "$DOMAIN" --agree-tos --redirect -m "$EMAIL" --non-interactive

echo "==> Restarting app"
sudo -u greg XDG_RUNTIME_DIR=/run/user/$(id -u greg) systemctl --user restart se-registration

echo
echo "Done. Verify:  curl -I https://$DOMAIN"
