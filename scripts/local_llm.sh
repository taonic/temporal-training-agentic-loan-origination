#!/usr/bin/env bash
#
# Bring up the local offline LLM for Module 4 (Ollama + a small qwen model) and
# write the env vars that point the agent at it. Saves typing `docker compose up`,
# waiting for the model pull, and exporting three vars by hand.
#
# Usage (from anywhere in the repo):
#   ./scripts/local_llm.sh            # start Ollama + pull the model
#   ./scripts/local_llm.sh --proxy    # also start the optional LiteLLM proxy
#   ./scripts/local_llm.sh down       # stop everything
#
# After it finishes, load the env vars into your shell, then start the worker:
#   source .env.offline
#   npx ts-node module-4-ai-agent/starter/src/worker.ts
set -euo pipefail

cd "$(dirname "$0")/.."

MODEL="${AGENT_MODEL:-qwen2.5:1.5b}"
ENV_FILE=".env.offline"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required but not found. Install Docker Desktop first." >&2
  exit 1
fi

# Stop everything (covers the optional proxy profile too) and exit.
if [ "${1:-}" = "down" ]; then
  docker compose --profile proxy down
  rm -f "$ENV_FILE"
  echo "Offline stack stopped."
  exit 0
fi

USE_PROXY=0
COMPOSE_ARGS=()
if [ "${1:-}" = "--proxy" ]; then
  USE_PROXY=1
  COMPOSE_ARGS=(--profile proxy)
fi

echo "Starting Ollama (pulling $MODEL on first run — that's ~1GB, please wait)…"
docker compose "${COMPOSE_ARGS[@]}" up -d --remove-orphans

# Poll Ollama's API until the model shows up (the one-shot ollama-pull container
# downloads it in the background).
echo -n "Waiting for $MODEL to be ready"
ready=0
for _ in $(seq 1 180); do
  if curl -fsS http://localhost:11434/api/tags 2>/dev/null | grep -q "$MODEL"; then
    ready=1
    break
  fi
  echo -n "."
  sleep 2
done
echo

if [ "$ready" -ne 1 ]; then
  echo "Timed out waiting for the model. Check the pull with:" >&2
  echo "  docker compose logs -f ollama-pull" >&2
  exit 1
fi

# Write the env vars the agent reads. Direct-to-Ollama by default; via the local
# LiteLLM proxy when --proxy was used.
if [ "$USE_PROXY" -eq 1 ]; then
  echo -n "Waiting for the LiteLLM proxy"
  for _ in $(seq 1 60); do
    if curl -fsS http://localhost:4000/health/liveliness >/dev/null 2>&1; then break; fi
    echo -n "."
    sleep 2
  done
  echo
  cat > "$ENV_FILE" <<EOF
export LLM_BASE_URL=http://localhost:4000/v1
export LLM_API_KEY=sk-local
export AGENT_MODEL=agent-model
EOF
else
  cat > "$ENV_FILE" <<EOF
export LLM_BASE_URL=http://localhost:11434/v1
export LLM_API_KEY=ollama
export AGENT_MODEL=$MODEL
EOF
fi

echo "Ready. Wrote $ENV_FILE. Next:"
echo "  source $ENV_FILE"
echo "  npx ts-node module-4-ai-agent/starter/src/worker.ts"
echo
echo "Stop later with: ./scripts/local_llm.sh down"
