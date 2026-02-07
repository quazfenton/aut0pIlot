# PR Autopilot Deployment Options

This document explains three ways to deploy PR Autopilot on Zo Computer with public webhook access.

## Prerequisites

Before using any of these options, ensure you have:

```bash
# Required environment variables
export GITHUB_TOKEN="your_github_token"
export WEBHOOK_SECRET="your_webhook_secret"
export ZO_CLIENT_IDENTITY_TOKEN="your_zo_token"  # if using LLM features
```

## Option 1: Ngrok Reverse Proxy

Automatically creates a public URL using ngrok when starting the agent.

### Setup

1. Install ngrok:
```bash
npm install -g ngrok
```

2. Run with the automated script:
```bash
cd /home/workspace/Skills/pr-autopilot
./start-with-ngrok.sh
```

3. Use the displayed public URL in your GitHub App settings:
   - Webhook URL: `[ngrok-url]/webhook`
   - Webhook Secret: same secret you used

### Notes
- The script will display the public URL after starting
- Ngrok provides temporary URLs that change on restart
- Requires internet access for ngrok tunnel

## Option 2: n8n Proxy Server

Runs a proxy server that forwards requests from n8n's public URL to your PR Autopilot.

### Setup

1. Install dependencies:
```bash
cd /home/workspace/Skills/pr-autopilot
npm install express http-proxy-middleware cors body-parser
```

2. Start your PR Autopilot agent separately:
```bash
GITHUB_TOKEN="..." WEBHOOK_SECRET="..." bun run scripts/agent.ts
```

3. Start the proxy server:
```bash
TARGET_AGENT_URL="http://localhost:3000" node n8n-proxy.js
```

4. Configure n8n to use your n8n public URL with `/webhook` path

## Option 3: n8n Execute Command

Use n8n's Execute Command node to run PR Autopilot directly.

### n8n Workflow Setup

1. **HTTP In Node** - Set up webhook endpoint in n8n
2. **Execute Command Node** - Configure to run this command:

```bash
cd /home/workspace/Skills/pr-autopilot && \
GITHUB_TOKEN="$GITHUB_TOKEN" \
WEBHOOK_SECRET="$WEBHOOK_SECRET" \
TARGET_AGENT_URL="http://localhost:3000" \
node webhook-forwarder.js
```

Or for simpler execution:

```bash
cd /home/workspace/Skills/pr-autopilot && \
./run-via-n8n.sh
```

### Environment Variables in n8n

In n8n, make sure to pass these environment variables to the Execute Command node:
- `GITHUB_TOKEN`
- `WEBHOOK_SECRET`
- `TARGET_AGENT_URL` (usually `http://localhost:3000`)

## Option 3 Alternative: Direct Webhook Forwarding

For more sophisticated webhook handling, use the webhook forwarder:

1. Install axios dependency:
```bash
npm install axios
```

2. In n8n, set up:
   - HTTP In Node to receive GitHub webhooks
   - Execute Command Node with:
```bash
cd /home/workspace/Skills/pr-autopilot && \
TARGET_AGENT_URL="http://localhost:3000" \
WEBHOOK_SECRET="$WEBHOOK_SECRET" \
node webhook-forwarder.js
```

## Testing

After setting up any option, test the webhook:

```bash
curl -X POST http://[your-public-url]/webhook \
  -H "Content-Type: application/json" \
  -d '{"test": "webhook"}'
```

You should see log messages in your PR Autopilot agent indicating the request was received.

## Troubleshooting

- **Connection refused**: Make sure your PR Autopilot agent is running on the target port
- **Webhook verification failed**: Verify your webhook secret matches between GitHub and your configuration
- **Permission denied**: Check that your user has permissions to run the scripts
- **Timeout errors**: Increase timeout values in the scripts if needed