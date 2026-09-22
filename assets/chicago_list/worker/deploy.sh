#!/usr/bin/env bash
# Deploy the Chicago chat Worker from the repo root.
# Run as: bash assets/chicago_list/worker/deploy.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WORKER_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load .env from the repo root so the model API keys and WRANGLER_WORKER_NAME are available.
set -a
# shellcheck source=../../../.env
source "$REPO_ROOT/.env"
set +a

# Either provider alone is enough to run the widget; only both missing is fatal.
if [[ -z "${GEMINI_API_KEY:-}" && -z "${GROQ_API_KEY:-}" ]]; then
    echo "error: neither GEMINI_API_KEY nor GROQ_API_KEY is set in $REPO_ROOT/.env" >&2
    exit 1
fi
if [[ -z "${WRANGLER_WORKER_NAME:-}" ]]; then
    echo "error: WRANGLER_WORKER_NAME is not set in $REPO_ROOT/.env" >&2
    exit 1
fi

# Secrets go up before the deploy so a rotated key is live the moment the new code is.
# Whichever key is absent is skipped; models on that provider then return a clear 500.
for KEY_NAME in GEMINI_API_KEY GROQ_API_KEY; do
    KEY_VALUE="${!KEY_NAME:-}"
    if [[ -z "$KEY_VALUE" ]]; then
        echo "==> Skipping $KEY_NAME (not set in .env)"
        continue
    fi
    echo "==> Setting $KEY_NAME secret on Worker '$WRANGLER_WORKER_NAME'..."
    echo "$KEY_VALUE" | npx wrangler secret put "$KEY_NAME" --name "$WRANGLER_WORKER_NAME"
done

echo "==> Deploying Worker '$WRANGLER_WORKER_NAME'..."
cd "$WORKER_DIR"
npx wrangler deploy --config wrangler.toml --name "$WRANGLER_WORKER_NAME"
