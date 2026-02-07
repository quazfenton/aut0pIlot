#!/usr/bin/env node

/**
 * Generate correct HMAC-SHA256 signature for test webhook payload
 */

import crypto from 'crypto';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
if (!WEBHOOK_SECRET) {
  console.error('❌ WEBHOOK_SECRET environment variable is required');
  console.error('Usage: WEBHOOK_SECRET=your-secret node generate-test-signature.js');
  process.exit(1);
}

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

console.log('Test payload:');
console.log(payloadString);
console.log('\nCorrect signature:');
console.log(`sha256=${signature}`);
console.log('\nWebhook secret used:');
console.log(WEBHOOK_SECRET);