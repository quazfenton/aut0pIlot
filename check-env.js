#!/usr/bin/env node

console.log('Environment variables:');
console.log('');

console.log('Authentication:');
const hasPersonalToken = !!process.env.GITHUB_TOKEN;
const hasGitHubApp = !!(process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY);

if (hasPersonalToken) {
  console.log('  ✅ GITHUB_TOKEN: (set)');
  console.log('     Using token authentication');
} else {
  console.log('  ❌ GITHUB_TOKEN: (not set)');
}

console.log('');

if (hasGitHubApp) {
  console.log('  ✅ GITHUB_APP_ID: (set)');
  console.log('  ✅ GITHUB_PRIVATE_KEY: (set)');
  console.log('     Using GitHub App authentication');
  if (process.env.GITHUB_APP_INSTALLATION_ID) {
    console.log('  ✅ GITHUB_APP_INSTALLATION_ID: (set)');
  } else {
    console.log('  ⚠️  GITHUB_APP_INSTALLATION_ID: (not set)');
  }
} else {
  console.log('  ❌ GitHub App credentials: (not set)');
}

console.log('');

if (!hasPersonalToken && !hasGitHubApp) {
  console.log('  ❌ ERROR: No authentication method configured!');
  console.log('     Provide either GITHUB_TOKEN or GitHub App credentials.');
} else if (hasPersonalToken && hasGitHubApp) {
  console.log('  ⚠️  WARNING: Multiple authentication methods configured.');
  console.log('     GITHUB_TOKEN will be used (takes precedence).');
}

console.log('');
console.log('Webhook:');
if (process.env.WEBHOOK_SECRET) {
  console.log('  ✅ WEBHOOK_SECRET: (set)');
} else {
  console.log('  ⚠️  WEBHOOK_SECRET: (not set - webhook verification will be skipped)');
}

console.log('');
console.log('Other:');
console.log('  AGENT_PORT:', process.env.AGENT_PORT || '3000 (default)');
console.log('  REDIS_URL:', process.env.REDIS_URL || '(not set - using in-memory queue)');
console.log('  ZO_CLIENT_IDENTITY_TOKEN:', process.env.ZO_CLIENT_IDENTITY_TOKEN ? '(set)' : '(not set)');
