#!/usr/bin/env node

/**
 * Test webhook endpoint with proper signature
 */

import crypto from 'crypto';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
if (!WEBHOOK_SECRET) {
  console.error('❌ WEBHOOK_SECRET environment variable is required');
  console.error('Usage: WEBHOOK_SECRET=your-secret node test-webhook.js');
  process.exit(1);
}

const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3000/webhook';

const testPayload = {
  "action": "created",
  "comment": {
    "id": 123456789,
    "body": "This is a test comment",
    "path": "test-file.js",
    "line": 10,
    "commit_id": "abc123def456",
    "user": {
      "login": "test-user"
    }
  },
  "repository": {
    "full_name": "test-org/test-repo"
  },
  "pull_request": {
    "number": 123
  }
};

// Convert to JSON string (minified, no extra spaces)
const payloadString = JSON.stringify(testPayload, null, 0);

// Generate HMAC-SHA256 signature
const signature = crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(payloadString, 'utf8')
  .digest('hex');

const headers = {
  'Content-Type': 'application/json',
  'X-GitHub-Event': 'pull_request_review_comment',
  'X-GitHub-Delivery': 'test-delivery-' + Date.now(),
  'X-Hub-Signature-256': `sha256=${signature}`,
  'User-Agent': 'GitHub-Hookshot/test'
};

console.log('Testing webhook with:');
console.log('URL:', AGENT_URL);
console.log('Payload length:', payloadString.length);
console.log('Signature:', `sha256=${signature}`);
console.log('');

try {
  const response = await fetch(AGENT_URL, {
    method: 'POST',
    headers: headers,
    body: payloadString
  });

  console.log('Response status:', response.status);
  console.log('Response text:', await response.text());
  
  if (response.ok) {
    console.log('✅ Webhook test passed!');
  } else {
    console.log('❌ Webhook test failed');
  }
} catch (error) {
  console.error('❌ Request failed:', error.message);
}