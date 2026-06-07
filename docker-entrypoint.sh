#!/bin/sh
# Bananadoro container entrypoint.
#
# Injects the shared HS256 secret into the cell manifest at start. The committed
# manifest keeps a dev literal so local `go run` works; in the container we
# override that line with $JWT_SECRET (which MUST match the bananauth host so
# bananadoro can verify bananauth-issued tokens locally). The Pulp host does
# not forward OS env into WASM cells, so the secret has to reach the cell via
# the manifest config — hence this substitution rather than a plain env var.
set -e

: "${JWT_SECRET:?set JWT_SECRET (shared HS256 secret with bananauth)}"
export HTTP_PORT="${HTTP_PORT:-3000}"

MANIFEST=/app/cell/pulp.cell.toml
# Inject secrets into the manifest at start (the committed manifest holds only
# placeholders). '#' sed delimiter avoids clashing with chars common in secrets.
sed -i "s#^jwt_secret = .*#jwt_secret = \"${JWT_SECRET}\"#" "$MANIFEST"
[ -n "$VAPID_PUBLIC" ]  && sed -i "s#^vapid_public = .*#vapid_public = \"${VAPID_PUBLIC}\"#" "$MANIFEST"
[ -n "$VAPID_PRIVATE" ] && sed -i "s#^vapid_private = .*#vapid_private = \"${VAPID_PRIVATE}\"#" "$MANIFEST"

exec /app/bananadoro-host -manifest "$MANIFEST"
