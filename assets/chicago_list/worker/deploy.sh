#!/usr/bin/env bash
# Deploy the Chicago chat Worker from the repo root.
# Run as: bash assets/chicago_list/worker/deploy.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WORKER_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load .env from the repo root so OLLAMA_API_KEY and WRANGLER_WORKER_NAME are available.
set -a
# shellcheck source=../../../.env
source "$REPO_ROOT/.env"
set +a

if [[ -z "${OLLAMA_API_KEY:-}" ]]; then
    echo "error: OLLAMA_API_KEY is not set in $REPO_ROOT/.env" >&2
    exit 1
fi
if [[ -z "${WRANGLER_WORKER_NAME:-}" ]]; then
    echo "error: WRANGLER_WORKER_NAME is not set in $REPO_ROOT/.env" >&2
    exit 1
fi

echo "==> Setting OLLAMA_API_KEY secret on Worker '$WRANGLER_WORKER_NAME'..."
echo "$OLLAMA_API_KEY" | npx wrangler secret put OLLAMA_API_KEY --name "$WRANGLER_WORKER_NAME"

echo "==> Deploying Worker '$WRANGLER_WORKER_NAME'..."
cd "$WORKER_DIR"
npx wrangler deploy --config wrangler.toml --name "$WRANGLER_WORKER_NAME"
