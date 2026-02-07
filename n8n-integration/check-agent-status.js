#!/usr/bin/env node

/**
 * Advanced script to check PR Autopilot agent status
 * Distinguishes between different states:
 * - running: Agent is actively running and listening
 * - stopped: Agent is not running
 * - error: Agent has an error state
 */

import { spawn } from 'child_process';
import { createConnection } from 'net';

// Helper function to safely execute pgrep command with spawn
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
      } else {
        // pgrep returns code 1 when no processes are found, which is not an error
        if (code === 1 && stderr === '') {
          resolve('');
        } else {
          reject(new Error(stderr || `pgrep failed with code ${code}`));
        }
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

// Check if the agent process is running and accessible
const checkAgentStatus = async () => {
  try {
    // First, check if the process is running
    const stdout = await safePgrep('bun.*scripts/agent.ts');
    const pids = stdout.trim().split('\n').filter(Boolean);

    if (pids.length > 0) {
      // Process is running, now check if port 3000 is accessible
      return new Promise((resolve) => {
        const socket = createConnection({ port: 3000, host: 'localhost' }, () => {
          // Port is accessible, try a quick health check
          socket.destroy();

          // Since we confirmed the port is open, the agent is running
          console.log(JSON.stringify({
            status: 'running',
            message: 'PR Autopilot agent is running and port 3000 is accessible',
            pids: pids
          }));
          resolve('running');
        });

        socket.setTimeout(3000); // 3 second timeout

        socket.on('timeout', () => {
          socket.destroy();
          console.log(JSON.stringify({
            status: 'starting_or_error',
            message: 'PR Autopilot process exists but port 3000 not responding',
            pids: pids
          }));
          resolve('starting_or_error');
        });

        socket.on('error', (err) => {
          socket.destroy();
          // Port not accessible but process exists - likely starting up or error
          console.log(JSON.stringify({
            status: 'starting_or_error',
            message: 'PR Autopilot process exists but not responding on port 3000',
            pids: pids,
            error: err.message
          }));
          resolve('starting_or_error');
        });
      });
    } else {
      // Process is not running
      console.log(JSON.stringify({
        status: 'stopped',
        message: 'PR Autopilot agent is not running'
      }));
      return 'stopped';
    }
  } catch (err) {
    // pgrep failed, likely no process running
    console.log(JSON.stringify({
      status: 'error',
      message: `Error checking process: ${err.message}`
    }));
    return 'error';
  }
};

// Run the check
checkAgentStatus()
  .then(status => {
    // Exit with different codes based on status for n8n
    if (status === 'running') {
      process.exit(0);  // Success
    } else if (status === 'stopped') {
      process.exit(0);  // Still success, just indicating stopped state
    } else {
      process.exit(1);  // Error state
    }
  })
  .catch(err => {
    console.error('Critical error in status check:', err);
    process.exit(1);
  });