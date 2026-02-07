#!/bin/bash

# Mock environment variables for PR Autopilot
export GITHUB_TOKEN="mock_token"
export GITHUB_APP_TOKEN="mock_token"
export WEBHOOK_SECRET="mock_secret"
export ZO_CLIENT_IDENTITY_TOKEN="mock_zo_token"
export AGENT_PORT=${PORT:-3000}

echo "Starting PR Autopilot Agent..."
echo "Port: $AGENT_PORT"
echo "Webhook endpoint: http://localhost:$AGENT_PORT/webhook"

# Start the agent
exec bun run scripts/agent.ts