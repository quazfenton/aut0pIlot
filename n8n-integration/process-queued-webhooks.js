#!/usr/bin/env node

/**
 * Queued webhook processor.
 *
 * Lifecycle rules:
 *   - If an agent is already listening on AGENT_PORT, USE IT — never kill it.
 *   - If no agent is listening, start one and track its PID so we can stop it
 *     later (only processes WE started get stopped).
 *   - After the queue is drained, stop the agent ONLY if we were the ones who
 *     started it in this run.
 */

import fs from 'fs/promises';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import net from 'net';

// ===== Paths =====
const QUEUE_DIR = '/tmp/pr-autopilot-queue';
const PROCESSED_DIR = '/tmp/pr-autopilot-processed';
const ERROR_DIR = '/tmp/pr-autopilot-error';

const PROCESSOR_LOCK = '/tmp/pr-autopilot-processor.lock';
const AGENT_PID_FILE = '/tmp/pr-autopilot-agent.pid';

// ===== Config =====
const AGENT_PORT = Number(process.env.AGENT_PORT ?? 3000);
const AGENT_START_TIMEOUT_MS = 30_000;
const PORT_CHECK_INTERVAL_MS = 500;
const MAX_RETRIES = 3;

// ===== Setup =====
await fs.mkdir(QUEUE_DIR, { recursive: true });
await fs.mkdir(PROCESSED_DIR, { recursive: true });
await fs.mkdir(ERROR_DIR, { recursive: true });

// Track whether THIS run started the agent so we know if we should stop it
let weStartedAgent = false;

/* ------------------------------------------------------------------ */
/* Lock handling                                                       */
/* ------------------------------------------------------------------ */
async function acquireLock() {
  try {
    await fs.writeFile(PROCESSOR_LOCK, `${process.pid}`, { flag: 'wx' });
    return true;
  } catch {
    try {
      const existingPid = parseInt(await fs.readFile(PROCESSOR_LOCK, 'utf8'), 10);
      if (Number.isNaN(existingPid)) {
        console.log('Lock file contains invalid PID, removing stale lock');
        await fs.rm(PROCESSOR_LOCK, { force: true });
        await fs.writeFile(PROCESSOR_LOCK, `${process.pid}`, { flag: 'wx' });
        return true;
      }

      try {
        process.kill(existingPid, 0);
        const stat = await fs.stat(PROCESSOR_LOCK);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > 5 * 60 * 1000) {
          console.log(`Lock held by PID ${existingPid} for ${Math.round(ageMs / 1000)}s, forcing takeover`);
          await fs.rm(PROCESSOR_LOCK, { force: true });
          await fs.writeFile(PROCESSOR_LOCK, `${process.pid}`, { flag: 'wx' });
          return true;
        }
        return false;
      } catch {
        console.log(`Lock held by dead PID ${existingPid}, removing stale lock`);
        await fs.rm(PROCESSOR_LOCK, { force: true });
        await fs.writeFile(PROCESSOR_LOCK, `${process.pid}`, { flag: 'wx' });
        return true;
      }
    } catch {
      return false;
    }
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
    socket.setTimeout(2000);
    socket
      .once('connect', () => { socket.destroy(); resolve(true); })
      .once('error', () => resolve(false))
      .once('timeout', () => { socket.destroy(); resolve(false); })
      .connect(port, '127.0.0.1');
  });
}

/**
 * Ensure an agent is listening on AGENT_PORT.
 * If one is already running (manually or from a previous run), just use it.
 * Only start a new one if nothing is listening.
 */
async function ensureAgentReady() {
  // First check: is anything already listening?
  if (await isPortOpen(AGENT_PORT)) {
    console.log(`Agent already listening on port ${AGENT_PORT}, using it`);
    weStartedAgent = false;
    return;
  }

  // Nothing listening — we need to start one
  console.log(`No agent on port ${AGENT_PORT}, starting one…`);

  const envVars = {
    ...process.env,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
    ZO_CLIENT_IDENTITY_TOKEN: process.env.ZO_CLIENT_IDENTITY_TOKEN || '',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
    AGENT_PORT: AGENT_PORT.toString()
  };

  const child = spawn(
    'bun',
    ['run', 'n8n-integration/agent-status.ts'],
    {
      cwd: '/home/workspace/Skills/pr-autopilot',
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: envVars
    }
  );

  await fs.writeFile(AGENT_PID_FILE, `${child.pid}`);
  console.log(`Agent started with PID ${child.pid}`);
  weStartedAgent = true;

  child.on('error', (err) => {
    console.error('Agent process error:', err.message);
  });

  child.on('exit', (code, signal) => {
    console.log(`Agent process exited (code=${code}, signal=${signal})`);
    fs.rm(AGENT_PID_FILE, { force: true }).catch(() => {});
  });

  child.stdout.on('data', (data) => {
    const output = data.toString().trim();
    if (output) console.log('Agent:', output);
  });

  child.stderr.on('data', (data) => {
    const output = data.toString().trim();
    if (output) console.error('Agent err:', output);
  });

  child.unref();

  // Wait for port to become available
  const start = Date.now();
  while (Date.now() - start < AGENT_START_TIMEOUT_MS) {
    if (await isPortOpen(AGENT_PORT)) {
      console.log(`Agent ready on port ${AGENT_PORT}`);
      return;
    }
    await new Promise(r => setTimeout(r, PORT_CHECK_INTERVAL_MS));
  }

  // Timeout — kill the child we started
  try { process.kill(child.pid, 'SIGTERM'); } catch {}
  weStartedAgent = false;
  throw new Error(`Agent failed to start within ${AGENT_START_TIMEOUT_MS / 1000}s`);
}

/**
 * Stop the agent ONLY if we started it in this run.
 * Never kill a manually-started or externally-managed agent.
 */
async function stopAgentIfWeStartedIt() {
  if (!weStartedAgent) {
    return; // We didn't start it — hands off
  }

  try {
    const pidStr = await fs.readFile(AGENT_PID_FILE, 'utf8');
    const pid = Number(pidStr);
    if (!Number.isFinite(pid) || pid <= 0) return;

    try {
      process.kill(pid, 0); // Check alive
      console.log(`Stopping agent we started (PID ${pid})`);
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already dead
    }
    await fs.rm(AGENT_PID_FILE, { force: true });
  } catch {
    // No PID file or read error
  }
}

/* ------------------------------------------------------------------ */
/* Processing logic                                                    */
/* ------------------------------------------------------------------ */
async function processQueue() {
  const files = (await fs.readdir(QUEUE_DIR)).filter(f => f.endsWith('.json'));

  if (files.length === 0) {
    console.log('Queue empty, nothing to do');
    // Check if a processor-started agent is running and idle.
    // Only stop agents we started (tracked by PID file), never manually-started ones.
    try {
      const pidStr = await fs.readFile(AGENT_PID_FILE, 'utf8').catch(() => '');
      if (pidStr) {
        const pid = Number(pidStr);
        // Verify the PID is still alive
        try { process.kill(pid, 0); } catch { return; } // Dead PID — nothing to stop

        // Check if agent's internal queue is idle via health endpoint
        try {
          const healthRes = await fetch(`http://localhost:${AGENT_PORT}/health`);
          if (healthRes.ok) {
            const health = await healthRes.json();
            const queueLen = health.queue?.length ?? 0;
            const processing = health.queue?.processing ?? 0;
            if (queueLen === 0 && processing === 0) {
              console.log(`Agent (PID ${pid}) idle, stopping it`);
              process.kill(pid, 'SIGTERM');
              await fs.rm(AGENT_PID_FILE, { force: true });
            } else {
              console.log(`Agent still busy (queue=${queueLen}, processing=${processing}), leaving it running`);
            }
          }
        } catch {
          // Can't reach health endpoint — leave it alone
        }
      }
    } catch {
      // No PID file or read error — nothing to do
    }
    return;
  }

  console.log(`${files.length} queued webhook(s) to process`);
  await ensureAgentReady();

  let processed = 0;
  let failed = 0;

  for (const file of files) {
    const filePath = path.join(QUEUE_DIR, file);
    let entry;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      entry = JSON.parse(raw);
    } catch (err) {
      console.error(`Skipping ${file}: bad JSON (${err.message})`);
      await fs.rename(filePath, path.join(ERROR_DIR, `${file}.bad.json`));
      continue;
    }

    if (!entry.payload) {
      console.error(`Skipping ${file}: missing payload`);
      await fs.rename(filePath, path.join(ERROR_DIR, `${file}.nopayload.json`));
      continue;
    }

    const retries = entry.retryCount ?? 0;
    if (retries >= MAX_RETRIES) {
      console.error(`Skipping ${file}: exceeded ${MAX_RETRIES} retries`);
      await fs.rename(filePath, path.join(ERROR_DIR, file));
      continue;
    }

    try {
      const bodyToSend = entry.rawBody || JSON.stringify(entry.payload);
      const originalSignature = entry.headers?.['x-hub-signature-256'] || entry.headers?.['X-Hub-Signature-256'];

      const res = await fetch(`http://localhost:${AGENT_PORT}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Delivery': entry.headers?.['x-github-delivery'] || entry.headers?.['X-GitHub-Delivery'] || entry.deliveryId || 'unknown',
          'X-GitHub-Event': entry.headers?.['x-github-event'] || entry.headers?.['X-GitHub-Event'] || entry.eventName || 'unknown',
          'X-Hub-Signature-256': originalSignature || 'sha256=missing',
          'X-Webhook-Source': 'pr-autopilot-queue'
        },
        body: bodyToSend
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);

      await fs.rename(filePath, path.join(PROCESSED_DIR, file));
      processed++;
      console.log(`✓ ${file} (${entry.eventName || 'unknown'})`);
    } catch (err) {
      failed++;
      entry.retryCount = retries + 1;
      entry.lastAttempt = Date.now();
      entry.error = err.message;
      await fs.writeFile(filePath, JSON.stringify(entry, null, 2));
      console.error(`✗ ${file}: ${err.message}`);
    }
  }

  console.log(`Done: ${processed} processed, ${failed} failed`);

  // Do NOT stop the agent here. The agent has its own internal job queue
  // that needs time to generate patches, apply them, commit, and push.
  // Killing it now would discard all the jobs we just delivered.
  //
  // The agent will be stopped:
  //   - Manually by the user
  //   - By the next processor run if there's nothing to do and we started it
  //   - By the scheduled n8n workflow after an idle period
  //
  // If we started the agent and the webhook queue is empty, we leave it
  // running so it can finish its internal job processing.
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
