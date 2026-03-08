#!/usr/bin/env node

/**
 * Agent Lifecycle Manager
 * 
 * Manages the PR Autopilot agent process:
 * - Starts agent when queue has items
 * - Monitors agent health
 * - Stops agent when queue is empty and idle
 * - Prevents multiple instances
 * - Handles graceful shutdown
 */

import fs from 'fs/promises';
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';

// Configuration
const AGENT_PORT = Number(process.env.AGENT_PORT ?? 3000);
const QUEUE_DIR = process.env.QUEUE_DIR || '/tmp/pr-autopilot-queue';
const PROCESSED_DIR = process.env.PROCESSED_DIR || '/tmp/pr-autopilot-processed';
const AGENT_START_TIMEOUT_MS = Number(process.env.AGENT_START_TIMEOUT_MS ?? 30000);
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS ?? 60000);
const HEALTH_CHECK_INTERVAL_MS = Number(process.env.HEALTH_CHECK_INTERVAL_MS ?? 5000);

// State files
const PID_FILE = '/tmp/pr-autopilot-agent.pid';
const LOCK_FILE = '/tmp/pr-autopilot-manager.lock';

// State
let agentProcess = null;
let agentPid = null;
let lastActivity = Date.now();
let isShuttingDown = false;

const log = {
    info: (msg) => console.log(`\x1b[36m[LIFECYCLE]\x1b[0m ${msg}`),
    success: (msg) => console.log(`\x1b[32m[LIFECYCLE]\x1b[0m ${msg}`),
    warn: (msg) => console.log(`\x1b[33m[LIFECYCLE]\x1b[0m ${msg}`),
    error: (msg) => console.error(`\x1b[31m[LIFECYCLE]\x1b[0m ${msg}`),
    debug: (msg) => process.env.DEBUG && console.log(`\x1b[2m[LIFECYCLE]\x1b[0m ${msg}`)
};

/**
 * Check if a port is in use
 */
async function isPortOpen(port) {
    return new Promise((resolve) => {
        const socket = new http.Agent({ keepAlive: false });
        const req = http.get(`http://localhost:${port}/health`, { agent: socket, timeout: 2000 }, (res) => {
            res.resume();
            resolve(true);
        });
        
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}

/**
 * Get agent health status
 */
async function getAgentHealth() {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${AGENT_PORT}/health`, { timeout: 3000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve({
                            healthy: true,
                            data: JSON.parse(data)
                        });
                    } catch {
                        resolve({ healthy: true, data: {} });
                    }
                } else {
                    resolve({ healthy: false });
                }
            });
        });
        
        req.on('error', () => resolve({ healthy: false }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ healthy: false });
        });
    });
}

/**
 * Get queue length
 */
async function getQueueLength() {
    try {
        const files = await fs.readdir(QUEUE_DIR);
        return files.filter(f => f.endsWith('.json')).length;
    } catch {
        return 0;
    }
}

/**
 * Check if manager lock is held
 */
async function acquireLock() {
    try {
        await fs.writeFile(LOCK_FILE, `${process.pid}`, { flag: 'wx' });
        return true;
    } catch {
        try {
            const existingPid = parseInt(await fs.readFile(LOCK_FILE, 'utf8'), 10);
            if (Number.isNaN(existingPid)) {
                await fs.rm(LOCK_FILE, { force: true });
                await fs.writeFile(LOCK_FILE, `${process.pid}`, { flag: 'wx' });
                return true;
            }

            // FIX: Check lock age FIRST to detect stale locks, regardless of PID status
            // This prevents race condition where multiple managers see a dead PID and all try to acquire
            try {
                const stat = await fs.stat(LOCK_FILE);
                const ageMs = Date.now() - stat.mtimeMs;
                const isStale = ageMs > 5 * 60 * 1000; // 5 minutes

                if (isStale) {
                    log.warn(`Lock held by stale PID ${existingPid} (${Math.round(ageMs / 1000)}s old), forcing takeover`);
                    await fs.rm(LOCK_FILE, { force: true });
                    await fs.writeFile(LOCK_FILE, `${process.pid}`, { flag: 'wx' });
                    return true;
                }
            } catch (statError) {
                // Lock file doesn't exist or other error - proceed to cleanup and retry
                log.debug(`Lock stat failed: ${statError.message}`);
            }

            // Check if process is still alive (only if lock is not stale)
            try {
                process.kill(existingPid, 0);
                // Process is alive - lock is not stale, don't steal
                log.debug('Manager already running');
                return false;
            } catch {
                // Process is dead and lock is not stale - safe to take over
                log.debug(`Previous manager (PID ${existingPid}) exited, acquiring lock`);
                await fs.rm(LOCK_FILE, { force: true });
                await fs.writeFile(LOCK_FILE, `${process.pid}`, { flag: 'wx' });
                return true;
            }
        } catch {
            return false;
        }
    }
}

/**
 * Release manager lock
 */
async function releaseLock() {
    await fs.rm(LOCK_FILE, { force: true });
}

/**
 * Start the agent process
 */
async function startAgent() {
    if (agentProcess) {
        log.debug('Agent already started in this process');
        return true;
    }

    // Check if agent is already running on the port
    const portOpen = await isPortOpen(AGENT_PORT);
    if (portOpen) {
        log.info('Agent already running on port, using existing instance');
        return true;
    }

    log.info(`Starting agent on port ${AGENT_PORT}...`);

    const env = {
        ...process.env,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
        WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
        ZO_CLIENT_IDENTITY_TOKEN: process.env.ZO_CLIENT_IDENTITY_TOKEN || '',
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
        MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
        AGENT_PORT: AGENT_PORT.toString()
    };

    return new Promise((resolve, reject) => {
        const scriptPath = path.join(process.cwd(), 'scripts', 'agent.ts');
        
        agentProcess = spawn('bun', ['run', scriptPath], {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env
        });

        agentPid = agentProcess.pid;
        log.success(`Agent started with PID ${agentPid}`);

        // Save PID to file
        fs.writeFile(PID_FILE, `${agentPid}`).catch(err => {
            log.warn(`Failed to save PID file: ${err.message}`);
        });

        // Handle stdout
        agentProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            if (output) {
                log.debug(`Agent: ${output}`);
                lastActivity = Date.now();
            }
        });

        // Handle stderr
        agentProcess.stderr.on('data', (data) => {
            const output = data.toString().trim();
            if (output) {
                log.warn(`Agent err: ${output}`);
            }
        });

        // Handle exit
        agentProcess.on('exit', (code, signal) => {
            log.info(`Agent exited (code=${code}, signal=${signal})`);
            agentProcess = null;
            agentPid = null;
            fs.rm(PID_FILE, { force: true }).catch(() => {});
        });

        agentProcess.on('error', (err) => {
            log.error(`Agent process error: ${err.message}`);
            reject(err);
        });

        // Wait for agent to be ready
        const startTime = Date.now();
        const checkReady = async () => {
            if (Date.now() - startTime > AGENT_START_TIMEOUT_MS) {
                log.error('Agent failed to start within timeout');
                if (agentProcess) {
                    agentProcess.kill('SIGTERM');
                }
                reject(new Error('Agent start timeout'));
                return;
            }

            const health = await getAgentHealth();
            if (health.healthy) {
                log.success('Agent is ready');
                lastActivity = Date.now();
                resolve(true);
            } else {
                setTimeout(checkReady, 500);
            }
        };

        checkReady();
    });
}

/**
 * Stop the agent process
 */
async function stopAgent() {
    if (!agentPid) {
        log.debug('No agent to stop');
        return;
    }

    log.info(`Stopping agent (PID ${agentPid})...`);

    try {
        // Send SIGTERM for graceful shutdown
        process.kill(agentPid, 'SIGTERM');
        
        // Wait for process to exit
        await new Promise((resolve) => {
            const checkExit = setInterval(() => {
                try {
                    process.kill(agentPid, 0);
                } catch {
                    clearInterval(checkExit);
                    resolve();
                }
            }, 100);
            
            // Timeout after 10 seconds
            setTimeout(() => {
                clearInterval(checkExit);
                // Force kill if still running
                try {
                    process.kill(agentPid, 'SIGKILL');
                } catch {}
                resolve();
            }, 10000);
        });

        log.success('Agent stopped');
    } catch (error) {
        log.warn(`Error stopping agent: ${error.message}`);
    } finally {
        agentProcess = null;
        agentPid = null;
        fs.rm(PID_FILE, { force: true }).catch(() => {});
    }
}

/**
 * Monitor agent and queue
 */
async function monitorLoop() {
    log.info('Starting monitor loop');

    while (!isShuttingDown) {
        try {
            const queueLength = await getQueueLength();
            const health = await getAgentHealth();

            log.debug(`Queue: ${queueLength}, Agent healthy: ${health.healthy}`);

            if (queueLength > 0) {
                lastActivity = Date.now();

                if (!health.healthy) {
                    log.info('Queue has items but agent not running, starting...');
                    await startAgent();
                } else {
                    log.debug(`Agent processing queue (queue: ${queueLength}, processing: ${health.data.queue?.processing || 0})`);
                }
            } else if (health.healthy) {
                const idleTime = Date.now() - lastActivity;
                
                if (idleTime > IDLE_TIMEOUT_MS) {
                    log.info(`Agent idle for ${idleTime}ms, stopping...`);
                    await stopAgent();
                } else {
                    log.debug(`Agent idle (${Math.round((IDLE_TIMEOUT_MS - idleTime) / 1000)}s until stop)`);
                }
            }
        } catch (error) {
            log.error(`Monitor error: ${error.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
    }

    log.info('Monitor loop stopped');
}

/**
 * Graceful shutdown
 */
async function shutdown() {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;
    log.info('Shutting down...');

    await stopAgent();
    await releaseLock();

    log.info('Shutdown complete');
    process.exit(0);
}

/**
 * Main entry point
 */
async function main() {
    // Acquire lock
    if (!(await acquireLock())) {
        log.info('Manager already running, exiting');
        process.exit(0);
    }

    // Handle signals
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGHUP', shutdown);

    // Cleanup on exit
    process.on('exit', () => {
        releaseLock().catch(() => {});
    });

    log.info('Agent Lifecycle Manager started');
    log.info(`Configuration: PORT=${AGENT_PORT}, QUEUE=${QUEUE_DIR}, IDLE_TIMEOUT=${IDLE_TIMEOUT_MS}ms`);

    // Start monitor loop
    monitorLoop().catch(error => {
        log.error(`Monitor loop failed: ${error.message}`);
        process.exit(1);
    });
}

// Run
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
