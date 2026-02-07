#!/bin/bash

# Script to run PR Autopilot agent via n8n Execute Command node
# This script can be called by n8n's Execute Command node

set -e  # Exit on any error

# Validate required environment variables
if [ -z "$GITHUB_TOKEN" ]; then
    echo "ERROR: GITHUB_TOKEN environment variable is required"
    exit 1
fi

if [ -z "$WEBHOOK_SECRET" ]; then
    echo "ERROR: WEBHOOK_SECRET environment variable is required"
    exit 1
fi

# Set default values
PROJECT_DIR="${PROJECT_DIR:-/home/workspace/Skills/pr-autopilot}"
PORT="${AGENT_PORT:-3000}"
TIMEOUT="${RUN_TIMEOUT:-300}"  # 5 minutes default

echo "Starting PR Autopilot agent..."
echo "Project directory: $PROJECT_DIR"
echo "Port: $PORT"
echo "Timeout: $TIMEOUT seconds"

# Change to project directory
cd "$PROJECT_DIR" || {
    echo "ERROR: Could not change to project directory: $PROJECT_DIR"
    exit 1
}

# Run the agent with timeout
timeout $TIMEOUT bun run scripts/agent.ts status || {
    echo "INFO: Status check completed or timed out"
}

# If you want to run the full agent (not just status), uncomment the next line:
# timeout $TIMEOUT GITHUB_TOKEN="$GITHUB_TOKEN" WEBHOOK_SECRET="$WEBHOOK_SECRET" AGENT_PORT="$PORT" bun run scripts/agent.ts

echo "PR Autopilot command completed"