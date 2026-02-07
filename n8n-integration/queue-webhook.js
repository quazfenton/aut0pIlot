#!/usr/bin/env node

/**
 * n8n-safe webhook queue script
 * Now reads payload from a temp JSON file path passed as argv[2]
 */

import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'node:util';
import {
  gunzip as gunzipCallback,
  brotliDecompress as brotliDecompressCallback,
  inflate as inflateCallback,
  inflateRaw as inflateRawCallback
} from 'node:zlib';

const QUEUE_DIR = '/tmp/pr-autopilot-queue';
await fs.mkdir(QUEUE_DIR, { recursive: true });

const gunzip = promisify(gunzipCallback);
const brotliDecompress = promisify(brotliDecompressCallback);
const inflate = promisify(inflateCallback);
const inflateRaw = promisify(inflateRawCallback);

const decompressors = [
  { name: 'gunzip', fn: gunzip },
  { name: 'brotli', fn: brotliDecompress },
  { name: 'inflateRaw', fn: inflateRaw },
  { name: 'inflate', fn: inflate }
];

function logDebug(message) {
  if (process.env.DEBUG === 'true') {
    console.error(`[queue-webhook] ${message}`);
  }
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function tryDecompressors(buffer) {
  for (const decompress of decompressors) {
    try {
      const decompressed = await decompress.fn(buffer);
      logDebug(`${decompress.name} succeeded`);
      return decompressed.toString('utf8');
    } catch (decompressErr) {
      logDebug(`${decompress.name} failed: ${decompressErr.message}`);
    }
  }
  return null;
}

async function parsePayloadFromFile(filePath) {
  logDebug(`Reading payload from file: ${filePath}`);
  let rawContent;
  try {
    rawContent = await fs.readFile(filePath, 'utf8');
  } catch (readErr) {
    throw new Error(`Failed to read file ${filePath}: ${readErr.message}`);
  }

  logDebug(`File read, length: ${rawContent.length} chars`);

  try {
    const parsed = JSON.parse(rawContent);

    // Check if the payload contains a rawBody field (from n8n workflow)
    if (parsed.rawBody !== undefined) {
      logDebug('Found rawBody in payload, using it for signature verification');
      return {
        body: parsed.body || parsed,
        headers: parsed.headers || {},
        rawBody: parsed.rawBody
      };
    }

    // Check if this is direct webhook data (body/headers structure)
    if (parsed.body && parsed.headers) {
      return {
        body: parsed.body,
        headers: parsed.headers,
        rawBody: parsed.rawBody || JSON.stringify(parsed.body, null, 0)
      };
    }

    // Fallback - treat entire parsed content as the webhook body
    return {
      body: parsed,
      headers: {},
      rawBody: JSON.stringify(parsed, null, 0)
    };
  } catch (parseErr) {
    logDebug(`Direct JSON parse failed: ${parseErr.message}`);
    // If somehow compressed (unlikely since we wrote JSON), try decompress
    const buffer = Buffer.from(rawContent);
    const decompressedText = await tryDecompressors(buffer);
    if (decompressedText) {
      return JSON.parse(decompressedText);
    }
    throw parseErr;
  }
}

try {
  const tempFilePath = process.argv[2];
  if (!tempFilePath) throw new Error('Missing temp file path argument');

  // Sanitize the file path to prevent directory traversal attacks
  const resolvedPath = path.resolve(tempFilePath);
  const allowedDirs = ['/tmp', '/var/tmp'];  // Common temp directories
  
  // Ensure the resolved path starts with one of the allowed directories
  const isAllowed = allowedDirs.some(dir => 
    resolvedPath.startsWith(dir + path.sep) || resolvedPath === dir
  );
  
  if (!isAllowed) {
    throw new Error(`Invalid file path: ${tempFilePath}. Only files in allowed temp directories are permitted.`);
  }

  const webhookData = await parsePayloadFromFile(resolvedPath);
  const payload = webhookData.body ?? webhookData ?? {};
  const headers = webhookData.headers ?? {};
  const rawBody = webhookData.rawBody ?? JSON.stringify(webhookData.body ?? webhookData ?? {}, null, 0);  // minified

  const queueEntry = {
    id: generateId(),
    timestamp: Date.now(),
    deliveryId:
      headers['x-github-delivery'] ||
      headers['X-GitHub-Delivery'] ||
      generateId(),
    eventName:
      headers['x-github-event'] ||
      headers['X-GitHub-Event'] ||
      'unknown',
    headers,
    payload,
    rawBody
  };

  const filePath = path.join(QUEUE_DIR, `${queueEntry.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(queueEntry, null, 2));

  console.log(`Queued webhook ${queueEntry.deliveryId} (event: ${queueEntry.eventName})`);

  // Optional: clean up temp file
  await fs.unlink(resolvedPath).catch(() => {});

  process.exit(0);
} catch (err) {
  console.error('Queue failed:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
}