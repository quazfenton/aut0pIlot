#!/bin/bash

# Script to start PR Autopilot with ngrok tunnel
set -e

# Check if required tools are installed
if ! command -v ngrok &> /dev/null; then
    echo "Installing ngrok..."
    npm install -g ngrok
fi

if [ -z "$GITHUB_TOKEN" ]; then
    echo "Error: GITHUB_TOKEN environment variable is required"
    exit 1
fi

if [ -z "$WEBHOOK_SECRET" ]; then
    echo "Error: WEBHOOK_SECRET environment variable is required"
    exit 1
fi

# Set default port
PORT=${AGENT_PORT:-3000}

echo "Starting PR Autopilot with ngrok tunnel..."
echo "Port: $PORT"

# Start the PR Autopilot agent in the background
echo "Starting PR Autopilot agent..."
GITHUB_TOKEN="$GITHUB_TOKEN" WEBHOOK_SECRET="$WEBHOOK_SECRET" AGENT_PORT="$PORT" bun run scripts/agent.ts &
AGENT_PID=$!

# Wait a moment for the agent to start
sleep 3

# Start ngrok tunnel
echo "Starting ngrok tunnel on port $PORT..."
ngrok http $PORT --log stdout > ngrok.log 2>&1 &
NGROK_PID=$!

# Print the public URL
echo "Waiting for ngrok to establish tunnel..."
sleep 5
PUBLIC_URL=$(curl -s http://localhost:4040/api/tunnels | jq -r '.tunnels[0].public_url' 2>/dev/null)

if [ ! -z "$PUBLIC_URL" ] && [ "$PUBLIC_URL" != "null" ]; then
    echo ""
    echo "🎉 PR Autopilot is now accessible at:"
    echo "   $PUBLIC_URL/webhook"
    echo ""
    echo "Configure this URL in your GitHub App settings:"
    echo "   Webhook URL: $PUBLIC_URL/webhook"
    echo "   Webhook Secret: (use the same secret you provided)"
    echo ""
else
    echo "⚠️  Could not get ngrok URL. Check ngrok dashboard at http://localhost:4040"
    echo "   Or check ngrok.log for details"
fi

# Wait for processes
wait $AGENT_PID
wait $NGROK_PID