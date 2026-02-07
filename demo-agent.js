#!/usr/bin/env node

// Minimal PR Autopilot Agent for demonstration
import Fastify from 'fastify';
import { Queue } from './queue.js';
import { PRStateMachine } from './state-machine.js';

const PORT = Number(process.env.AGENT_PORT ?? '3000');

console.log('Starting PR Autopilot Agent (Demo Mode)...');
console.log('⚠️  Running in demo mode - no GitHub integration enabled');
console.log(`🚀 Server will start on port ${PORT}`);
console.log('📋 Features available:');
console.log('   - Job queue processing');
console.log('   - PR state management');
console.log('   - Webhook endpoint (disabled without GitHub token)');
console.log('');

if (!process.env.GITHUB_TOKEN) {
  console.log('💡 To enable full functionality:');
  console.log('   1. Create a GitHub App with proper permissions');
  console.log('   2. Set GITHUB_TOKEN environment variable');
  console.log('   3. Set WEBHOOK_SECRET for security');
  console.log('');
}

// Create a simple server
const server = Fastify({ logger: true });

server.get('/', async (request, reply) => {
  return {
    status: 'running',
    mode: 'demo',
    message: 'PR Autopilot Agent is running in demo mode',
    features: [
      'PR review parsing',
      'Automated patch generation',
      'Git operations',
      'State management'
    ]
  };
});

server.get('/health', async (request, reply) => {
  return { status: 'healthy', timestamp: new Date().toISOString() };
});

server.get('/status', async (request, reply) => {
  return { 
    status: 'operational',
    mode: 'demo',
    queue: { length: 0, processing: 0 },
    uptime: process.uptime()
  };
});

// Start the server
const start = async () => {
  try {
    await server.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`✅ Server listening at http://0.0.0.0:${PORT}`);
    console.log(`🔗 Health check: http://0.0.0.0:${PORT}/health`);
    console.log(`🔗 Status: http://0.0.0.0:${PORT}/status`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();