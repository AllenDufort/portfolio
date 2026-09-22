#!/usr/bin/env bash
# Deploy the Travel Planner Worker from the repo root.
# Run as: bash assets/travel/worker/deploy.sh
#
# On first run, this script creates the KV namespace "travel-planner-db" and
# writes its id back into wrangler.toml automatically so subsequent deploys
# use the same namespace.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WORKER_DIR="$(cd "$(dirname "$0")" && pwd)"
TOML="$WORKER_DIR/wrangler.toml"

# Load .env from the repo root so the model API keys are available.
set -a
# shellcheck source=../../../.env
source "$REPO_ROOT/.env"
set +a

# Either provider alone is enough to run the app; only both missing is fatal.
if [[ -z "${GEMINI_API_KEY:-}" && -z "${GROQ_API_KEY:-}" ]]; then
    echo "error: neither GEMINI_API_KEY nor GROQ_API_KEY is set in $REPO_ROOT/.env" >&2
    exit 1
fi

TRAVEL_WORKER_NAME="${TRAVEL_WORKER_NAME:-travel-planner}"
KV_NAMESPACE_TITLE="${TRAVEL_WORKER_NAME}-db"

# ── KV namespace bootstrap ────────────────────────────────────────────────
# Read the current id from wrangler.toml (blank = not yet created).
CURRENT_ID=$(grep -A2 'binding = "TRAVEL_DB"' "$TOML" | grep 'id = ' | sed 's/.*id = "\(.*\)".*/\1/' | tr -d '[:space:]')

if [[ -z "$CURRENT_ID" ]]; then
    echo "==> Creating KV namespace '$KV_NAMESPACE_TITLE'..."
    # wrangler kv namespace create prints a line like:
    #   { id: "abc123" }
    KV_OUTPUT=$(cd "$WORKER_DIR" && npx wrangler kv namespace create "$KV_NAMESPACE_TITLE" 2>&1)
    echo "$KV_OUTPUT"
    KV_ID=$(echo "$KV_OUTPUT" | grep -oE '"id":\s*"[^"]+"' | grep -oE '"[^"]+"$' | tr -d '"')

    if [[ -z "$KV_ID" ]]; then
        echo "error: could not parse KV namespace id from wrangler output." >&2
        echo "  Output was: $KV_OUTPUT" >&2
        exit 1
    fi
    echo "==> KV namespace created: $KV_ID"

    # Create a preview namespace too (used by wrangler dev).
    PREVIEW_OUTPUT=$(cd "$WORKER_DIR" && npx wrangler kv namespace create "${KV_NAMESPACE_TITLE}_preview" --preview 2>&1)
    PREVIEW_ID=$(echo "$PREVIEW_OUTPUT" | grep -oE '"id":\s*"[^"]+"' | grep -oE '"[^"]+"$' | tr -d '"')
    [[ -z "$PREVIEW_ID" ]] && PREVIEW_ID="$KV_ID"   # fallback: share the prod namespace

    # Patch wrangler.toml in-place.
    # macOS sed needs a backup extension; we delete it afterwards.
    sed -i.bak \
        -e "s|^id *= *\"\".*|id = \"$KV_ID\"|" \
        -e "s|^preview_id *= *\"\".*|preview_id = \"$PREVIEW_ID\"|" \
        "$TOML"
    rm -f "$TOML.bak"
    echo "==> wrangler.toml updated with KV namespace id."
else
    echo "==> KV namespace already configured: $CURRENT_ID"
fi

# ── Deploy ────────────────────────────────────────────────────────────────
# Deploy using the config file only — do not pass --name, it conflicts with
# the name already set in wrangler.toml and causes API 10007 errors.
echo "==> Deploying Worker '$TRAVEL_WORKER_NAME'..."
cd "$WORKER_DIR"
npx wrangler deploy worker.js --config wrangler.toml

# ── Secrets (set after deploy so the worker exists) ───────────────────────
# Whichever key is absent is skipped; its models then return a clear 500.
for KEY_NAME in GEMINI_API_KEY GROQ_API_KEY; do
    KEY_VALUE="${!KEY_NAME:-}"
    if [[ -z "$KEY_VALUE" ]]; then
        echo "==> Skipping $KEY_NAME (not set in .env)"
        continue
    fi
    echo "==> Setting $KEY_NAME secret on Worker '$TRAVEL_WORKER_NAME'..."
    echo "$KEY_VALUE" | npx wrangler secret put "$KEY_NAME" --config wrangler.toml
done

echo ""
echo "✅  Done. Data is stored in KV namespace '$KV_NAMESPACE_TITLE'."
