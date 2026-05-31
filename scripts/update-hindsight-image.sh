#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_PATH="$ROOT_DIR/docker/hindsight-image.env"

if [[ ! -f "$ENV_PATH" ]]; then
  printf '%s\n' "missing $ENV_PATH" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_PATH"

image="${BEEP_HINDSIGHT_IMAGE:-ghcr.io/vectorize-io/hindsight:v0.7.0}"

docker pull "$image"
digest="$(docker image inspect --format='{{index .RepoDigests 0}}' "$image")"

printf '%s\n' "## hindsight"
printf 'image:  %s\n' "$image"
printf 'digest: %s\n' "$digest"

cat > "$ROOT_DIR/docker/hindsight-image.lock" <<EOF
BEEP_HINDSIGHT_IMAGE=$image
BEEP_HINDSIGHT_IMAGE_DIGEST=$digest
EOF
