#!/usr/bin/env node

/**
 * Robust queued webhook processor with:
 * - single-run lock
 * - agent lifecycle management
 * - port readiness checks
 * - graceful shutdown
 */

import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import net from 'net';
import * as crypto from 'crypto';

// ===== Paths =====
const QUEUE_DIR = '/tmp/pr-autopilot-queue';
const PROCESSED_DIR = '/tmp/pr-autopilot-processed';
const ERROR_DIR = '/tmp/pr-autopilot-error';

const PROCESSOR_LOCK = '/tmp/pr-autopilot-processor.lock';
const AGENT_PID_FILE = '/tmp/pr-autopilot-agent.pid';

// ===== Config =====
const AGENT_PORT = 3000;
const AGENT_START_TIMEOUT_MS = 20_000;
const PORT_CHECK_INTERVAL_MS = 500;
const MAX_RETRIES = 3;

// ===== Setup =====
await fs.mkdir(QUEUE_DIR, { recursive: true });
await fs.mkdir(PROCESSED_DIR, { recursive: true });
await fs.mkdir(ERROR_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Lock handling                                                       */
/* ------------------------------------------------------------------ */
async function acquireLock() {
  try {
    await fs.writeFile(PROCESSOR_LOCK, `${process.pid}`, { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

async function releaseLock() {
  await fs.rm(PROCESSOR_LOCK, { force: true });
}

/* ------------------------------------------------------------------ */
/* Agent helpers                                                       */
/* ------------------------------------------------------------------ */
async function isPortOpen(port) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket
      .once('connect', () => {
        socket.destroy();
        resolve(true);
      })
      .once('error', () => resolve(false))
      .connect(port, '127.0.0.1');
  });
}

async function isAgentRunning() {
  try {
    const pid = await fs.readFile(AGENT_PID_FILE, 'utf8');
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function startAgentIfNeeded() {
  if (await isAgentRunning()) return;

  console.log('Starting PR Autopilot agent…');

  // Ensure required environment variables are available
  const envVars = {
    ...process.env,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
    ZO_CLIENT_IDENTITY_TOKEN: process.env.ZO_CLIENT_IDENTITY_TOKEN || ''
  };

  const child = spawn(
    'bun',
    ['run', 'scripts/agent.ts'],
    {
      cwd: '/home/workspace/Skills/pr-autopilot',
      detached: true,
      stdio: 'ignore',
      env: envVars
    }
  );

  child.unref();
  await fs.writeFile(AGENT_PID_FILE, `${child.pid}`);

  const start = Date.now();
  while (Date.now() - start < AGENT_START_TIMEOUT_MS) {
    if (await isPortOpen(AGENT_PORT)) {
      console.log('Agent is ready on port 3000');
      return;
    }
    await new Promise(r => setTimeout(r, PORT_CHECK_INTERVAL_MS));
  }

  throw new Error('Agent failed to start within timeout');
}

async function stopAgentIfRunning() {
  try {
    const pid = Number(await fs.readFile(AGENT_PID_FILE, 'utf8'));
    process.kill(pid, 'SIGTERM');
    await fs.rm(AGENT_PID_FILE, { force: true });
    console.log('Agent stopped');
  } catch {
    /* noop */
  }
}

/* ------------------------------------------------------------------ */
/* Processing logic                                                    */
/* ------------------------------------------------------------------ */
async function processQueue() {
  const files = (await fs.readdir(QUEUE_DIR)).filter(f => f.endsWith('.json'));

  if (files.length === 0) {
    console.log('Queue empty, nothing to do');
    await stopAgentIfRunning();
    return;
  }

  await startAgentIfNeeded();

  let processed = 0;

  for (const file of files) {
    const filePath = path.join(QUEUE_DIR, file);
    let entry;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      entry = JSON.parse(raw);
    } catch (err) {
      console.error(`Skipping ${file}: failed to parse JSON (${err.message})`);
      await fs.rename(filePath, path.join(ERROR_DIR, `${file}.bad.json`));
      continue;
    }

    if (!entry.payload) {
      console.error(`Skipping ${file}: missing payload object`);
      await fs.rename(filePath, path.join(ERROR_DIR, `${file}.nopayload.json`));
      continue;
    }

    const retries = entry.retryCount ?? 0;
    if (retries >= MAX_RETRIES) {
      await fs.rename(filePath, path.join(ERROR_DIR, file));
      continue;
    }

    try {
      const bodyToSend = entry.rawBody || JSON.stringify(entry.payload);

      // Use the ORIGINAL signature from GitHub, don't recompute it
      const originalSignature = entry.headers['x-hub-signature-256'] || entry.headers['X-Hub-Signature-256'];
      
      if (!originalSignature) {
        console.warn(`Warning: No signature found for ${file}, using queue bypass`);
      }

      const res = await fetch('http://localhost:3000/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Delivery': entry.headers['x-github-delivery'] || entry.headers['X-GitHub-Delivery'] || entry.deliveryId,
          'X-GitHub-Event': entry.headers['x-github-event'] || entry.headers['X-GitHub-Event'] || entry.eventName,
          'X-Hub-Signature-256': originalSignature || 'sha256=missing',
          'X-Webhook-Source': 'pr-autopilot-queue'  // Indicate this is from our queue
        },
        body: bodyToSend
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      await fs.rename(filePath, path.join(PROCESSED_DIR, file));
      processed++;
    } catch (err) {
      entry.retryCount = retries + 1;
      entry.lastAttempt = Date.now();
      entry.error = err.message;
      await fs.writeFile(filePath, JSON.stringify(entry, null, 2));
    }
  }

  console.log(`Processed ${processed} webhook(s)`);

  const remaining = (await fs.readdir(QUEUE_DIR)).filter(f => f.endsWith('.json'));
  if (remaining.length === 0) {
    await stopAgentIfRunning();
  }
}

/* ------------------------------------------------------------------ */
/* Entrypoint                                                          */
/* ------------------------------------------------------------------ */
if (!(await acquireLock())) {
  console.log('Processor already running, exiting');
  process.exit(0);
}

try {
  await processQueue();
} catch (err) {
  console.error('Processor failed:', err.message);
  process.exitCode = 1;
} finally {
  await releaseLock();
}
