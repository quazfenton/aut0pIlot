#!/usr/bin/env node

/**
 * Enhanced n8n Webhook Handler for PR Autopilot
 * This script handles incoming webhooks from n8n with proper authentication
 * and forwards them to the PR Autopilot agent with signature preservation
 */

const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const url = require('url');

// Configuration
const AGENT_HOST = process.env.AGENT_HOST || 'localhost';
const AGENT_PORT = process.env.AGENT_PORT || '3000';
const AGENT_ENDPOINT = process.env.AGENT_ENDPOINT || '/webhook';
const DEBUG = process.env.DEBUG === 'true';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

function log(message) {
    if (DEBUG) {
        console.error(`[DEBUG ${new Date().toISOString()}] ${message}`);
    }
}

function logInfo(message) {
    console.log(`[INFO ${new Date().toISOString()}] ${message}`);
}

function logError(message) {
    console.error(`[ERROR ${new Date().toISOString()}] ${message}`);
}

function logWarn(message) {
    console.warn(`[WARN ${new Date().toISOString()}] ${message}`);
}

// Validate required environment variables
if (!process.env.GITHUB_TOKEN) {
    logError('ERROR: GITHUB_TOKEN environment variable is required');
    process.exit(1);
}

if (!WEBHOOK_SECRET) {
    logWarn('WARNING: WEBHOOK_SECRET not configured, signature verification will be skipped');
}

/**
 * Verify GitHub webhook signature
 */
function verifySignature(payload, signature, secret) {
    if (!signature || !secret) {
        logWarn('Missing signature or secret for verification');
        return false;
    }

    try {
        const expectedSignature = 'sha256=' + crypto
            .createHmac('sha256', secret)
            .update(payload, 'utf8')
            .digest('hex');

        const isValid = crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );

        log(`Signature verification result: ${isValid}`);
        return isValid;
    } catch (error) {
        logError(`Signature verification error: ${error.message}`);
        return false;
    }
}

/**
 * Parse webhook data from n8n input
 */
function parseWebhookData(inputData) {
    try {
        // Preserve original raw body before parsing for signature verification
        const originalRawBody = typeof inputData === 'string' ? inputData : JSON.stringify(inputData);
        
        const webhookData = JSON.parse(inputData);
        
        // Extract rawBody if already present (from n8n workflow that captured it)
        const existingRawBody = webhookData.rawBody;
        
        // Extract payload and headers from various n8n formats
        let payload = webhookData.body || webhookData.payload || webhookData;
        let headers = webhookData.headers || {};

        // Handle nested structures
        if (payload.body) {
            payload = payload.body;
        }
        if (payload.headers) {
            headers = { ...headers, ...payload.headers };
        }

        // Extract GitHub-specific headers
        const deliveryId = headers['X-GitHub-Delivery'] || 
                          headers['x-github-delivery'] || 
                          webhookData.deliveryId ||
                          'unknown-' + Date.now();

        const eventName = headers['X-GitHub-Event'] || 
                        headers['x-github-event'] || 
                        webhookData.eventName ||
                        'unknown';

        const signature = headers['X-Hub-Signature-256'] || 
                         headers['x-hub-signature-256'] || 
                         webhookData.signature;

        const rawBody = existingRawBody || originalRawBody || JSON.stringify(payload);

        logInfo(`Parsed webhook: ${eventName} (Delivery: ${deliveryId})`);
        log(`Payload size: ${rawBody.length} bytes`);
        log(`Signature present: ${!!signature}`);

        return {
            payload,
            headers,
            deliveryId,
            eventName,
            signature,
            rawBody
        };
    } catch (error) {
        logError(`Failed to parse webhook data: ${error.message}`);
        throw error;
    }
}

/**
 * Forward webhook to PR Autopilot agent
 */
async function forwardToAgent(webhookData) {
    const { payload, headers, deliveryId, eventName, signature, rawBody } = webhookData;

    // Prepare headers for forwarding - preserve all GitHub headers
    const forwardHeaders = {
        'Content-Type': 'application/json',
        'X-GitHub-Event': eventName,
        'X-GitHub-Delivery': deliveryId,
        'X-Webhook-Source': 'pr-autopilot-queue',
        // Preserve original signature if available
        ...(signature && { 'X-Hub-Signature-256': signature }),
        // Copy other potentially useful headers
        ...(headers['X-GitHub-Hook-ID'] && { 'X-GitHub-Hook-ID': headers['X-GitHub-Hook-ID'] }),
        ...(headers['X-GitHub-Hook-Installation-Target-ID'] && { 
            'X-GitHub-Hook-Installation-Target-ID': headers['X-GitHub-Hook-Installation-Target-ID'] 
        }),
        ...(headers['X-GitHub-Hook-Installation-Target-Type'] && { 
            'X-GitHub-Hook-Installation-Target-Type': headers['X-GitHub-Hook-Installation-Target-Type'] 
        })
    };

    const options = {
        hostname: AGENT_HOST,
        port: parseInt(AGENT_PORT),
        path: AGENT_ENDPOINT,
        method: 'POST',
        headers: forwardHeaders,
        timeout: 30000 // 30 second timeout
    };

    logInfo(`Forwarding webhook to http://${AGENT_HOST}:${AGENT_PORT}${AGENT_ENDPOINT}`);

    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let responseData = '';
            
            res.on('data', (chunk) => {
                responseData += chunk;
            });
            
            res.on('end', () => {
                logInfo(`Agent response: HTTP ${res.statusCode}`);
                
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const responseJson = JSON.parse(responseData);
                        resolve({
                            success: true,
                            statusCode: res.statusCode,
                            response: responseJson
                        });
                    } catch (parseError) {
                        resolve({
                            success: true,
                            statusCode: res.statusCode,
                            response: responseData
                        });
                    }
                } else {
                    logError(`Agent returned error: HTTP ${res.statusCode}`);
                    logError(`Response body: ${responseData}`);
                    
                    try {
                        const responseJson = JSON.parse(responseData);
                        reject({
                            success: false,
                            statusCode: res.statusCode,
                            error: responseData,
                            response: responseJson
                        });
                    } catch (parseError) {
                        reject({
                            success: false,
                            statusCode: res.statusCode,
                            error: responseData,
                            response: responseData
                        });
                    }
                }
            });
        });
        
        req.on('error', (e) => {
            logError(`Request to agent failed: ${e.message}`);
            reject({
                success: false,
                error: `Failed to connect to agent: ${e.message}`
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject({
                success: false,
                error: 'Request to agent timed out'
            });
        });
        
        // Send the raw body to preserve any formatting
        req.write(rawBody);
        req.end();
    });
}

/**
 * Queue webhook for later processing if agent is unavailable
 */
async function queueWebhook(webhookData) {
    const queueDir = '/tmp/pr-autopilot-queue';
    const fs = require('fs').promises;
    
    try {
        await fs.mkdir(queueDir, { recursive: true });
        
        const queueEntry = {
            timestamp: new Date().toISOString(),
            deliveryId: webhookData.deliveryId,
            eventName: webhookData.eventName,
            payload: webhookData.payload,
            headers: webhookData.headers,
            rawBody: webhookData.rawBody,
            retryCount: 0
        };
        
        const filename = `${queueDir}/webhook-${webhookData.deliveryId}-${Date.now()}.json`;
        await fs.writeFile(filename, JSON.stringify(queueEntry, null, 2));
        
        logInfo(`Webhook queued: ${filename}`);
        return true;
    } catch (error) {
        logError(`Failed to queue webhook: ${error.message}`);
        return false;
    }
}

/**
 * Main processing function
 */
async function processWebhook() {
    let inputData = '';
    
    // Read input from stdin (n8n passes webhook data via stdin)
    process.stdin.setEncoding('utf8');

    await new Promise((resolve, reject) => {
        process.stdin.on('readable', () => {
            let chunk;
            while ((chunk = process.stdin.read()) !== null) {
                inputData += chunk;
            }
        });

        process.stdin.on('end', resolve);
        process.stdin.on('error', reject);
    });

    try {
        // Parse the webhook data
        const webhookData = parseWebhookData(inputData);
        
        // Verify signature if secret is configured
        if (WEBHOOK_SECRET && webhookData.signature) {
            if (!verifySignature(webhookData.rawBody, webhookData.signature, WEBHOOK_SECRET)) {
                logError('Webhook signature verification failed');
                console.log(JSON.stringify({
                    success: false,
                    error: 'Webhook signature verification failed'
                }));
                process.exit(1);
            }
        } else if (WEBHOOK_SECRET) {
            logWarn('No signature provided in webhook');
        }

        // Try to forward to agent
        try {
            const result = await forwardToAgent(webhookData);
            
            // Success response in n8n format
            console.log(JSON.stringify({
                success: true,
                statusCode: result.statusCode,
                response: result.response,
                deliveryId: webhookData.deliveryId,
                eventName: webhookData.eventName
            }));
            
        } catch (forwardError) {
            logError(`Failed to forward webhook: ${forwardError.error}`);
            
            // Queue for later processing
            const queued = await queueWebhook(webhookData);
            
            console.log(JSON.stringify({
                success: false,
                error: forwardError.error,
                queued: queued,
                deliveryId: webhookData.deliveryId,
                eventName: webhookData.eventName
            }));
            
            // Don't exit with error code if we successfully queued it
            if (queued) {
                process.exit(0);
            } else {
                process.exit(1);
            }
        }
        
    } catch (error) {
        logError(`Webhook processing failed: ${error.message}`);
        console.error(JSON.stringify({
            success: false,
            error: `Failed to process webhook: ${error.message}`
        }));
        process.exit(1);
    }
}

// Handle process termination gracefully
process.on('SIGINT', () => {
    logInfo('Received SIGINT, exiting gracefully');
    process.exit(0);
});

process.on('SIGTERM', () => {
    logInfo('Received SIGTERM, exiting gracefully');
    process.exit(0);
});

// Start processing
processWebhook().catch(error => {
    logError(`Unhandled error in main process: ${error.message}`);
    process.exit(1);
});
