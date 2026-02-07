#!/usr/bin/env node

/**
 * Webhook forwarder from n8n to PR Autopilot
 * This script receives webhook data from n8n and forwards it to the PR Autopilot agent
 */

import express from 'express';
import axios from 'axios';
import crypto from 'crypto';

const app = express();
const PORT = process.env.FORWARDER_PORT || 8081;
const TARGET_AGENT_URL = process.env.TARGET_AGENT_URL || 'http://localhost:3000';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Middleware to parse raw body for signature verification
app.use(express.raw({ type: 'application/json', limit: '10mb' }));

// Endpoint that n8n will call
app.post('/forward-webhook', async (req, res) => {
  try {
    console.log(`Received webhook from n8n at ${new Date().toISOString()}`);
    
    // Extract GitHub headers from the request (passed from n8n)
    const githubHeaders = {
      'x-github-delivery': req.headers['x-github-delivery'],
      'x-github-event': req.headers['x-github-event'] || req.headers['x-webhook-event'],
      'x-hub-signature': req.headers['x-hub-signature'],
      'x-hub-signature-256': req.headers['x-hub-signature-256'],
    };

    // Forward to PR Autopilot agent
    const response = await axios.post(`${TARGET_AGENT_URL}/webhook`, req.body, {
      headers: {
        ...githubHeaders,
        'content-type': 'application/json',
      },
      timeout: 10000, // 10 second timeout
    });

    console.log(`Forwarded webhook to agent, response: ${response.status}`);
    res.status(response.status).json({ 
      success: true, 
      forwarded: true, 
      agentResponse: response.status 
    });

  } catch (error) {
    console.error('Error forwarding webhook:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    targetAgent: TARGET_AGENT_URL 
  });
});

// Simple test endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'n8n to PR Autopilot Webhook Forwarder',
    status: 'running',
    target: TARGET_AGENT_URL
  });
});

app.listen(PORT, () => {
  console.log(`Webhook forwarder running on port ${PORT}`);
  console.log(`Forwarding to: ${TARGET_AGENT_URL}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});