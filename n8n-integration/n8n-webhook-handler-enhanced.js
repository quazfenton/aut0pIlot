#!/usr/bin/env node

/**
 * Enhanced n8n Webhook Handler for PR Autopilot
 * 
 * Improvements:
 * - Properly preserves GitHub signature headers for authentication
 * - Stores raw body for signature verification
 * - Better error handling and logging
 * - Supports queue-based processing with agent lifecycle management
 */

const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');

// Configuration
const AGENT_HOST = process.env.AGENT_HOST || 'localhost';
const AGENT_PORT = process.env.AGENT_PORT || '3000';
const AGENT_ENDPOINT = process.env.AGENT_ENDPOINT || '/webhook';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const DEBUG = process.env.DEBUG === 'true';
const QUEUE_DIR = process.env.QUEUE_DIR || '/tmp/pr-autopilot-queue';

function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level}]`;
    
    if (level === 'ERROR') {
        console.error(`${prefix} ${message}`);
    } else if (DEBUG || level !== 'DEBUG') {
        console.log(`${prefix} ${message}`);
    }
}

/**
 * Compute HMAC SHA256 signature for GitHub webhook verification
 */
function computeSignature(payload, secret) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * Validate GitHub webhook signature
 */
function validateSignature(payload, signature, secret) {
    if (!signature || !secret) {
        log('Missing signature or secret', 'WARN');
        return false;
    }

    const expected = computeSignature(payload, secret);
    const isValid = crypto.timingSafeEqual(
        Buffer.from(signature, 'utf8'),
        Buffer.from(expected, 'utf8')
    );

    log(`Signature validation: ${isValid ? 'PASSED' : 'FAILED'}`, isValid ? 'DEBUG' : 'WARN');
    return isValid;
}

/**
 * Queue a webhook for later processing
 */
async function queueWebhook(webhookData) {
    const fs = require('fs').promises;
    const path = require('path');

    try {
        await fs.mkdir(QUEUE_DIR, { recursive: true });
    } catch (error) {
        log(`Failed to create queue directory: ${error.message}`, 'ERROR');
    }

    const filename = `webhook-${Date.now()}-${Math.random().toString(36).substring(2, 9)}.json`;
    const filePath = path.join(QUEUE_DIR, filename);

    const queueEntry = {
        ...webhookData,
        queuedAt: Date.now(),
        retryCount: 0
    };

    try {
        await fs.writeFile(filePath, JSON.stringify(queueEntry, null, 2));
        log(`Webhook queued: ${filename}`);
        return { success: true, filename };
    } catch (error) {
        log(`Failed to queue webhook: ${error.message}`, 'ERROR');
        return { success: false, error: error.message };
    }
}

/**
 * Forward webhook to PR Autopilot agent
 */
async function forwardWebhook(webhookData) {
    return new Promise((resolve, reject) => {
        const payload = webhookData.rawBody || JSON.stringify(webhookData.payload);
        const signature = webhookData.headers?.['X-Hub-Signature-256'] || 
                         webhookData.headers?.['x-hub-signature-256'];

        const options = {
            hostname: AGENT_HOST,
            port: parseInt(AGENT_PORT),
            path: AGENT_ENDPOINT,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'X-GitHub-Event': webhookData.headers?.['X-GitHub-Event'] || 
                                 webhookData.headers?.['x-github-event'] || 'ping',
                'X-GitHub-Delivery': webhookData.headers?.['X-GitHub-Delivery'] || 
                                     webhookData.headers?.['x-github-delivery'] || 'unknown',
                'X-Hub-Signature-256': signature || 'sha256=missing',
                'X-Webhook-Source': 'n8n-queue-processor'
            }
        };

        log(`Forwarding webhook to http://${AGENT_HOST}:${AGENT_PORT}${AGENT_ENDPOINT}`);
        log(`Event: ${options.headers['X-GitHub-Event']}, Delivery: ${options.headers['X-GitHub-Delivery']}`);

        const req = http.request(options, (res) => {
            let responseData = '';

            res.on('data', (chunk) => {
                responseData += chunk;
            });

            res.on('end', () => {
                log(`Agent response: HTTP ${res.statusCode}`);
                
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({
                        success: true,
                        statusCode: res.statusCode,
                        response: responseData
                    });
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
                }
            });
        });

        req.on('error', (error) => {
            log(`Request failed: ${error.message}`, 'ERROR');
            reject(error);
        });

        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.write(payload);
        req.end();
    });
}

/**
 * Check if agent is running and ready
 */
async function checkAgentHealth() {
    return new Promise((resolve) => {
        const options = {
            hostname: AGENT_HOST,
            port: parseInt(AGENT_PORT),
            path: '/health',
            method: 'GET',
            timeout: 5000
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const health = JSON.parse(data);
                        resolve({
                            healthy: true,
                            queueLength: health.queue?.length || 0,
                            processing: health.queue?.processing || 0
                        });
                    } catch {
                        resolve({ healthy: true });
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

        req.end();
    });
}

/**
 * Main processing function
 */
async function processWebhook() {
    // Read input from stdin (n8n passes webhook data via stdin)
    let inputData = '';
    
    return new Promise((resolve, reject) => {
        process.stdin.setEncoding('utf8');

        process.stdin.on('readable', () => {
            let chunk;
            while ((chunk = process.stdin.read()) !== null) {
                inputData += chunk;
            }
        });

        process.stdin.on('end', async () => {
            try {
                if (!inputData.trim()) {
                    throw new Error('No input received from stdin');
                }

                const webhookData = JSON.parse(inputData);
                log(`Received webhook from n8n`);

                // Extract payload and headers
                const payload = webhookData.body || webhookData.payload || {};
                const headers = webhookData.headers || {};
                const rawBody = webhookData.rawBody || JSON.stringify(payload);

                // Validate signature if secret is configured
                if (WEBHOOK_SECRET) {
                    const signature = headers['X-Hub-Signature-256'] || headers['x-hub-signature-256'];
                    
                    if (!signature) {
                        log('Missing signature header - webhook may be insecure', 'WARN');
                    } else {
                        const isValid = validateSignature(rawBody, signature, WEBHOOK_SECRET);
                        if (!isValid) {
                            throw new Error('Invalid webhook signature');
                        }
                        log('Webhook signature validated');
                    }
                }

                // Prepare webhook data for forwarding
                const preparedWebhook = {
                    payload,
                    rawBody,
                    headers,
                    eventName: headers['X-GitHub-Event'] || headers['x-github-event'],
                    deliveryId: headers['X-GitHub-Delivery'] || headers['x-github-delivery'],
                    queuedAt: Date.now()
                };

                // Check if agent is healthy
                const health = await checkAgentHealth();
                
                if (health.healthy) {
                    log(`Agent is healthy (queue: ${health.queueLength}, processing: ${health.processing})`);
                    
                    // Try to forward immediately
                    try {
                        const result = await forwardWebhook(preparedWebhook);
                        log('Webhook forwarded successfully');
                        
                        console.log(JSON.stringify({
                            success: true,
                            action: 'forwarded',
                            ...result
                        }));
                        resolve();
                        return;
                    } catch (error) {
                        log(`Forwarding failed: ${error.message}`, 'WARN');
                        log('Will queue for later processing');
                    }
                } else {
                    log('Agent not healthy or unreachable', 'WARN');
                }

                // Queue the webhook for later processing
                const queueResult = await queueWebhook(preparedWebhook);
                
                if (queueResult.success) {
                    console.log(JSON.stringify({
                        success: true,
                        action: 'queued',
                        filename: queueResult.filename,
                        message: 'Agent unavailable, webhook queued for processing'
                    }));
                } else {
                    throw new Error(`Failed to queue: ${queueResult.error}`);
                }

                resolve();

            } catch (error) {
                log(`Processing failed: ${error.message}`, 'ERROR');
                console.log(JSON.stringify({
                    success: false,
                    error: error.message,
                    stack: DEBUG ? error.stack : undefined
                }));
                reject(error);
            }
        });

        process.stdin.on('error', (error) => {
            log(`stdin error: ${error.message}`, 'ERROR');
            reject(error);
        });
    });
}

// Run the processor
processWebhook()
    .then(() => {
        log('Processing completed');
        process.exit(0);
    })
    .catch((error) => {
        log(`Fatal error: ${error.message}`, 'ERROR');
        process.exit(1);
    });
