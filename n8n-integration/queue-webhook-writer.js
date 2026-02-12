#!/usr/bin/env node

/**
 * Reads webhook payload from stdin, writes to queue, and triggers processor.
 * Usage in n8n Execute Command:
 *   echo '{{ JSON.stringify($json.payload) }}' | node n8n-integration/queue-webhook-writer.js
 *
 * Or more robustly via n8n Code node writing to a temp file:
 *   node n8n-integration/queue-webhook-writer.js < /tmp/payload.json
 */

import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

const QUEUE_DIR = '/tmp/pr-autopilot-queue';
await fs.mkdir(QUEUE_DIR, { recursive: true });

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Read all of stdin
const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const input = Buffer.concat(chunks).toString('utf8').trim();

if (!input) {
  console.error('No input received on stdin');
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(input);
} catch (err) {
  console.error(`Invalid JSON on stdin: ${err.message}`);
  process.exit(1);
}

// Build queue entry
const headers = payload.headers || {};
const queueEntry = {
  id: generateId(),
  timestamp: Date.now(),
  deliveryId: headers['x-github-delivery'] || headers['X-GitHub-Delivery'] || generateId(),
  eventName: headers['x-github-event'] || headers['X-GitHub-Event'] || 'unknown',
  headers,
  payload: payload.body || payload,
  rawBody: payload.rawBody || JSON.stringify(payload.body || payload)
};

const filePath = path.join(QUEUE_DIR, `${queueEntry.id}.json`);
await fs.writeFile(filePath, JSON.stringify(queueEntry, null, 2));
console.log(`Queued webhook ${queueEntry.deliveryId} (event: ${queueEntry.eventName})`);

// Trigger processor immediately (fire-and-forget)
const proc = spawn('node', ['n8n-integration/process-queued-webhooks.js'], {
  cwd: '/home/workspace/Skills/pr-autopilot',
  detached: true,
  stdio: 'ignore',
  env: process.env
});
proc.unref();

console.log('Triggered processor');
process.exit(0);
