#!/bin/bash

# n8n Webhook Handler for PR Autopilot
# This script handles incoming webhooks from GitHub and forwards them to the PR Autopilot agent

set -e  # Exit on any error

# Configuration
AGENT_HOST="${AGENT_HOST:-localhost}"
AGENT_PORT="${AGENT_PORT:-3000}"
AGENT_ENDPOINT="${AGENT_ENDPOINT:-/webhook}"
DEBUG="${DEBUG:-false}"

# Log function
log() {
    if [ "$DEBUG" = "true" ]; then
        echo "[DEBUG $(date '+%Y-%m-%d %H:%M:%S')] $1" >&2
    fi
}

# Validate required environment variables
if [ -z "$GITHUB_TOKEN" ]; then
    echo "ERROR: GITHUB_TOKEN environment variable is required"
    exit 1
fi

if [ -z "$WEBHOOK_SECRET" ]; then
    echo "ERROR: WEBHOOK_SECRET environment variable is required"
    exit 1
fi

# Capture webhook data from stdin (n8n sends webhook payload via stdin)
WEBHOOK_PAYLOAD=$(cat)

# Extract headers from environment variables (passed by n8n)
DELIVERY_ID="${GITHUB_DELIVERY_ID:-$(echo "$WEBHOOK_PAYLOAD" | jq -r '.delivery_id // empty')}"
EVENT_NAME="${GITHUB_EVENT:-$(echo "$WEBHOOK_PAYLOAD" | jq -r '.event_name // empty')}"

# If headers aren't available via environment, try to extract from payload
if [ -z "$DELIVERY_ID" ] || [ -z "$EVENT_NAME" ]; then
    log "Headers not found in environment, extracting from payload"
    DELIVERY_ID="${DELIVERY_ID:-$(echo "$WEBHOOK_PAYLOAD" | jq -r '.headers."X-GitHub-Delivery" // .headers."x-github-delivery" // empty')}"
    EVENT_NAME="${EVENT_NAME:-$(echo "$WEBHOOK_PAYLOAD" | jq -r '.headers."X-GitHub-Event" // .headers."x-github-event" // empty')}"
fi

log "Received webhook: $EVENT_NAME (Delivery: $DELIVERY_ID)"

# Validate that we have the required data
if [ -z "$EVENT_NAME" ]; then
    echo "ERROR: Could not determine GitHub event name"
    exit 1
fi

# Prepare headers for forwarding to PR Autopilot agent
HEADERS="-H 'X-GitHub-Event: $EVENT_NAME'"
if [ -n "$DELIVERY_ID" ]; then
    HEADERS="$HEADERS -H 'X-GitHub-Delivery: $DELIVERY_ID'"
fi

# Forward the webhook to the PR Autopilot agent
log "Forwarding webhook to http://$AGENT_HOST:$AGENT_PORT$AGENT_ENDPOINT"
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST \
    $HEADERS \
    -H "Content-Type: application/json" \
    --data-binary "@-" \
    "http://$AGENT_HOST:$AGENT_PORT$AGENT_ENDPOINT" <<< "$WEBHOOK_PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -eq 200 ] || [ "$HTTP_CODE" -eq 201 ]; then
    log "Webhook forwarded successfully (HTTP $HTTP_CODE)"
    echo "$RESPONSE_BODY" | jq -r '{"success": true, "response": .}'
else
    log "Failed to forward webhook (HTTP $HTTP_CODE)"
    echo "$RESPONSE_BODY" | jq -r ". + {\"success\": false, \"http_code\": $HTTP_CODE}"
    exit 1
fi