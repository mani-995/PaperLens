#!/bin/bash
CONF=/etc/nginx/nginx.conf
if ! grep -q "client_max_body_size" "$CONF"; then
  sed -i '/http {/a \    client_max_body_size 25M;' "$CONF"
fi
systemctl reload nginx