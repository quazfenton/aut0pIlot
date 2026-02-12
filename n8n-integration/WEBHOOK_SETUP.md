# Webhook Receiver Setup for n8n

## Recommended: Code Node + Execute Command

### Step 1: n8n Webhook Node
- Type: Webhook
- HTTP Method: POST
- Path: `pr-autopilot`
- Response Mode: `Respond to Webhook` (using a Respond node)

### Step 2: Code Node (Write Temp File)
Replace the shell-based JSON writing with a Code node:

```javascript
// n8n Code Node - JavaScript
const payload = {
  body: $input.first().json.body ?? {},
  headers: $input.first().json.headers ?? {},
  rawBody: JSON.stringify($input.first().json.body ?? {})
};

const fs = require('fs');
const tempFile = `/tmp/pr-autopilot-queue/incoming-${Date.now()}-${Math.random().toString(36).slice(2,6)}.json`;

// Ensure directory exists
fs.mkdirSync('/tmp/pr-autopilot-queue', { recursive: true });

// Write JSON file directly — no shell escaping needed
fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2));

return [{ json: { tempFile, status: 'queued' } }];
```

### Step 3: Execute Command Node (Trigger Processor)
```
cd /home/workspace/Skills/pr-autopilot && node n8n-integration/process-queued-webhooks.js
```

### Step 4: Respond to Webhook Node
- Response Code: 202
- Response Body: `{ "status": "queued" }`

## Alternative: Pipe via stdin
If you prefer a single Execute Command node:

```
cd /home/workspace/Skills/pr-autopilot/n8n-integration && echo '{{ JSON.stringify({ body: $json.body, headers: $json.headers }) }}' | node queue-webhook-writer.js
```

Note: This approach may still have issues with special characters in the payload body (backticks, single quotes, dollar signs). The Code Node approach above is more reliable.
