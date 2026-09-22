#!/usr/bin/env bash
# Deploy the Travel Planner Worker from the repo root.
# Run as: bash assets/travel/worker/deploy.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WORKER_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load .env from the repo root so ANTHROPIC_API_KEY and WRANGLER_WORKER_NAME are available.
set -a
# shellcheck source=../../../.env
source "$REPO_ROOT/.env"
set +a

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "error: ANTHROPIC_API_KEY is not set in $REPO_ROOT/.env" >&2
    exit 1
fi

# Use a separate worker name for the travel planner, defaulting to "travel-planner"
TRAVEL_WORKER_NAME="${TRAVEL_WORKER_NAME:-travel-planner}"

echo "==> Setting ANTHROPIC_API_KEY secret on Worker '$TRAVEL_WORKER_NAME'..."
echo "$ANTHROPIC_API_KEY" | npx wrangler secret put ANTHROPIC_API_KEY --name "$TRAVEL_WORKER_NAME"

echo "==> Deploying Worker '$TRAVEL_WORKER_NAME'..."
cd "$WORKER_DIR"
npx wrangler deploy --config wrangler.toml --name "$TRAVEL_WORKER_NAME"
