#!/bin/bash

# Script to check if PR Autopilot agent is running
# Uses absolute paths to avoid directory issues

cd /home/workspace/Skills/pr-autopilot/n8n-integration || {
    echo '{"status": "error", "message": "Could not change to integration directory"}'
    exit 1
}

# Check if the agent process is running
if pgrep -f "bun.*scripts/agent.ts" > /dev/null; then
    PIDS=$(pgrep -f "bun.*scripts/agent.ts" | tr '\n' ',' | sed 's/,$//')
    echo "{\"status\": \"running\", \"message\": \"PR Autopilot agent is running\", \"pids\": [$(pgrep -f "bun.*scripts/agent.ts" | sed 's/$/,/' | sed '$s/,$//')]}"
else
    echo "{\"status\": \"stopped\", \"message\": \"PR Autopilot agent is not running\"}"
fi