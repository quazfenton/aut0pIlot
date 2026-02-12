#!/usr/bin/env node

/**
 * Check PR Autopilot agent status.
 * Exit codes:
 *   0 = running
 *   2 = stopped
 *   1 = error
 */

import { spawn } from 'child_process';
import { createConnection } from 'net';

function safePgrep(pattern) {
  return new Promise((resolve, reject) => {
    const child = spawn('pgrep', ['-f', pattern]);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else if (code === 1 && stderr === '') {
        resolve('');
      } else {
        reject(new Error(stderr || `pgrep failed with code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

function checkPort(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host }, () => {
      socket.destroy();
      resolve({ accessible: true });
    });

    socket.setTimeout(timeoutMs);

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ accessible: false, reason: 'timeout' });
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({ accessible: false, reason: err.message });
    });
  });
}

async function checkVariant(pattern, label) {
  const stdout = await safePgrep(pattern);
  const pids = stdout.split('\n').filter(Boolean);
  if (pids.length === 0) return null;

  const portResult = await checkPort(3000, 'localhost', 3000);

  if (portResult.accessible) {
    return {
      status: 'running',
      message: `${label} is running and port 3000 is accessible`,
      pids
    };
  }

  return {
    status: 'starting_or_error',
    message: `${label} process exists but port 3000 not responding`,
    pids,
    ...(portResult.reason && { error: portResult.reason })
  };
}

const checkAgentStatus = async () => {
  try {
    const bunResult = await checkVariant('bun.*scripts/agent.ts', 'PR Autopilot agent');
    if (bunResult) return bunResult;

    const n8nResult = await checkVariant('bun.*n8n-integration/agent-status.ts', 'PR Autopilot agent (n8n version)');
    if (n8nResult) return n8nResult;

    return {
      status: 'stopped',
      message: 'PR Autopilot agent is not running'
    };
  } catch (err) {
    return {
      status: 'error',
      message: `Error checking process: ${err.message}`
    };
  }
};

checkAgentStatus()
  .then(result => {
    console.log(JSON.stringify(result));
    if (result.status === 'running') process.exit(0);
    if (result.status === 'stopped') process.exit(2);
    process.exit(1);
  })
  .catch(err => {
    console.error('Critical error in status check:', err);
    process.exit(1);
  });
