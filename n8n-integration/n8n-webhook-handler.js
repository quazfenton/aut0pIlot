#!/usr/bin/env node

/**
 * n8n Webhook Handler for PR Autopilot
 * This script handles incoming webhooks from n8n and forwards them to the PR Autopilot agent
 */

const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const url = require('url');

// Configuration
const AGENT_HOST = process.env.AGENT_HOST || 'localhost';
const AGENT_PORT = process.env.AGENT_PORT || '3000';
const AGENT_ENDPOINT = process.env.AGENT_ENDPOINT || '/webhook';
const DEBUG = process.env.DEBUG === 'true';

function log(message) {
    if (DEBUG) {
        console.error(`[DEBUG ${new Date().toISOString()}] ${message}`);
    }
}

// Validate required environment variables
if (!process.env.GITHUB_TOKEN) {
    console.error('ERROR: GITHUB_TOKEN environment variable is required');
    process.exit(1);
}

if (!process.env.WEBHOOK_SECRET) {
    console.error('ERROR: WEBHOOK_SECRET environment variable is required');
    process.exit(1);
}

// Read input from stdin (n8n passes webhook data via stdin)
let inputData = '';
process.stdin.setEncoding('utf8');

process.stdin.on('readable', () => {
    let chunk;
    while ((chunk = process.stdin.read()) !== null) {
        inputData += chunk;
    }
});

process.stdin.on('end', () => {
    try {
        const webhookData = JSON.parse(inputData);
        
        // Extract webhook payload and headers from n8n format
        const payload = webhookData.body || webhookData.payload || {};
        const headers = webhookData.headers || {};
        
        const deliveryId = headers['X-GitHub-Delivery'] || headers['x-github-delivery'];
        const eventName = headers['X-GitHub-Event'] || headers['x-github-event'];
        
        log(`Received webhook: ${eventName} (Delivery: ${deliveryId})`);
        
        // Prepare headers for forwarding to PR Autopilot agent
        const forwardHeaders = {
            'Content-Type': 'application/json',
            'X-GitHub-Event': eventName,
            'X-GitHub-Delivery': deliveryId,
            ...(headers['X-Hub-Signature-256'] && {'X-Hub-Signature-256': headers['X-Hub-Signature-256']}),
            ...(headers['X-GitHub-Hook-ID'] && {'X-GitHub-Hook-ID': headers['X-GitHub-Hook-ID']})
        };
        
        // Forward the webhook to the PR Autopilot agent
        const options = {
            hostname: AGENT_HOST,
            port: parseInt(AGENT_PORT),
            path: AGENT_ENDPOINT,
            method: 'POST',
            headers: forwardHeaders
        };
        
        log(`Forwarding webhook to http://${AGENT_HOST}:${AGENT_PORT}${AGENT_ENDPOINT}`);
        
        const req = http.request(options, (res) => {
            let responseData = '';
            
            res.on('data', (chunk) => {
                responseData += chunk;
            });
            
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    log(`Webhook forwarded successfully (HTTP ${res.statusCode})`);
                    
                    // Output success response in n8n format
                    console.log(JSON.stringify({
                        success: true,
                        statusCode: res.statusCode,
                        response: JSON.parse(responseData)
                    }));
                } else {
                    log(`Failed to forward webhook (HTTP ${res.statusCode})`);
                    
                    // Output error response in n8n format
                    console.log(JSON.stringify({
                        success: false,
                        statusCode: res.statusCode,
                        error: responseData,
                        response: JSON.parse(responseData)
                    }));
                    
                    process.exit(1);
                }
            });
        });
        
        req.on('error', (e) => {
            log(`Problem with request: ${e.message}`);
            console.error(JSON.stringify({
                success: false,
                error: e.message
            }));
            process.exit(1);
        });
        
        req.write(JSON.stringify(payload));
        req.end();
        
    } catch (error) {
        console.error(JSON.stringify({
            success: false,
            error: `Failed to parse input: ${error.message}`
        }));
        process.exit(1);
    }
});