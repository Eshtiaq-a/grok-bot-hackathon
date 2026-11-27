#!/usr/bin/env bash
# Deploys the gateway and dashboard to your CreateOS project provisioned by Stripe Projects.
# Builds from a clean copy so .env, git history and the test-foil labels never leave this machine.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="${CREATEOS_PROJECT_ID:?Set CREATEOS_PROJECT_ID in your environment or .env}"
ENV_ID="${CREATEOS_ENVIRONMENT_ID:?Set CREATEOS_ENVIRONMENT_ID in your environment or .env}"
KEY="${CREATEOS_PROJECT_API_KEY:-$(grep '^CREATEOS_PROJECT_API_KEY=' .env 2>/dev/null | cut -d= -f2- | tr -d "'\"")}"
if [ -z "$KEY" ]; then
  echo "Set CREATEOS_PROJECT_API_KEY in your environment or .env" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -R package.json package-lock.json tsconfig.json Dockerfile .dockerignore packages apps "$STAGE"/
rm -rf "$STAGE/apps/gateway/.runtime"
mkdir -p "$STAGE/data/offers" "$STAGE/data/events"
[ -f data/events/recorded.jsonl ] && cp data/events/recorded.jsonl "$STAGE/data/events/"
if compgen -G "data/offers/*.json" > /dev/null; then
  for f in data/offers/*.json; do
    case "$f" in *.foil.json) ;; *) cp "$f" "$STAGE/data/offers/" ;; esac
  done
fi

(cd "$STAGE" && createos --api-key "$KEY" deploy --project "$PROJECT_ID" --dir .)

# Promote the newest deployment, then put every older one to sleep. Two running gateways
# would each keep a warm pool and drain the sandbox quota.
list() { createos --api-key "$KEY" -o json deployments list --project "$PROJECT_ID"; }
NEW_ID="$(list | python3 -c 'import sys,json; d=json.load(sys.stdin); d=d if isinstance(d,list) else d.get("data",[]); print(d[0]["id"])')"
createos --api-key "$KEY" deployments promote --project "$PROJECT_ID" --environment "$ENV_ID" --deployment "$NEW_ID"
for old in $(list | python3 -c 'import sys,json; d=json.load(sys.stdin); d=d if isinstance(d,list) else d.get("data",[]); print(" ".join(x["id"] for x in d[1:] if x.get("status")=="deployed"))'); do
  createos --api-key "$KEY" deployments sleep --force --project "$PROJECT_ID" --deployment "$old"
done
echo "Live deployment: $NEW_ID"
