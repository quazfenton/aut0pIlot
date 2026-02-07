#!/usr/bin/env node

// n8n webhook proxy for PR Autopilot
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import cors from 'cors';
import bodyParser from 'body-parser';

const app = express();
const PORT = process.env.N8N_PROXY_PORT || 8080;
const TARGET_AGENT_URL = process.env.TARGET_AGENT_URL || 'http://localhost:3000';

// Middleware
app.use(cors());
app.use(bodyParser.raw({ type: 'application/json', limit: '10mb' }));

// Log incoming requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Proxy middleware for webhook endpoint
const webhookProxy = createProxyMiddleware('/webhook', {
  target: TARGET_AGENT_URL,
  changeOrigin: true,
  onProxyReq: (proxyReq, req, res) => {
    // Forward all headers including GitHub-specific ones
    Object.keys(req.headers).forEach(key => {
      proxyReq.setHeader(key, req.headers[key]);
    });
    
    console.log(`Forwarding webhook to: ${TARGET_AGENT_URL}/webhook`);
  },
  onProxyRes: (proxyRes, req, res) => {
    console.log(`Response from agent: ${proxyRes.statusCode}`);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    targetAgent: TARGET_AGENT_URL 
  });
});

// Register the proxy middleware
app.use(webhookProxy);

// Fallback for other routes
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Only /webhook endpoint is available' });
});

// Error handling
app.use((error, req, res, next) => {
  console.error('Proxy error:', error);
  res.status(500).json({ error: 'Proxy error occurred' });
});

// Start the proxy server
app.listen(PORT, () => {
  console.log(`n8n webhook proxy server running on port ${PORT}`);
  console.log(`Forwarding /webhook requests to: ${TARGET_AGENT_URL}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});