#!/usr/bin/env bash
# Clears all captured dry-run messages from Mailpit via its REST API. Mailpit's
# UI port is published to the host by compose.yaml, so this hits it directly —
# no docker/podman exec needed. Run from anywhere; override MAILPIT_URL if the
# UI port differs from the compose default.
set -euo pipefail

MAILPIT_URL="${MAILPIT_URL:-http://localhost:8025}"

curl -sf -X DELETE "$MAILPIT_URL/api/v1/messages"
echo "Cleared Mailpit messages at $MAILPIT_URL"
