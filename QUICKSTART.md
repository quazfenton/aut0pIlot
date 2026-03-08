# PR Autopilot - Quick Start Guide

## 🚀 Getting Started in 5 Minutes

### Prerequisites

```bash
# Required
- Node.js 18+ or Bun
- GitHub Personal Access Token
- (Optional) Gemini API key or Mistral API key
```

### 1. Install Dependencies

```bash
# Using Bun (recommended)
bun install

# Or using npm
npm install
```

### 2. Configure Environment

```bash
# Copy example environment file
cp env_example .env

# Edit .env with your credentials
nano .env
```

**Required variables:**
```bash
# GitHub Authentication
GITHUB_TOKEN=ghp_your_personal_access_token

# Webhook Security (generate a random secret)
WEBHOOK_SECRET=your_random_secret_here

# LLM APIs (at least one required)
GEMINI_API_KEY=your_gemini_key
MISTRAL_API_KEY=your_mistral_key

# Agent Configuration
AGENT_PORT=3000
```

### 3. Start the Agent

```bash
# Simple start
bun run agent

# Or with TypeScript
bunx tsx scripts/agent.ts
```

### 4. Test the Agent

```bash
# Check health endpoint
curl http://localhost:3000/health

# Expected response:
# {"status":"ok","queue":{"length":0,"processing":0}}
```

### 5. Process Your First PR

```bash
# Manual enqueue
bun run agent process owner/repo 123

# Or send a webhook to http://localhost:3000/webhook
```

---

## 📋 Basic Usage

### Command Line Interface

```bash
# Start agent server
bun run agent

# Check queue status
bun run agent status

# Manually process a PR
bun run agent process <repo> <pr-number>
# Example:
bun run agent process quazfenton/jarvis 42
```

### Configuration File

Create `.github/pr-autopilot.yml` in your repository:

```yaml
autofix:
  enabled: true
  max_iterations: 5
  risk_level: medium  # low, medium, or high
  allowed_bots:
    - code-reviewer[bot]
    - security-bot[bot]
  branch_strategy: update_same_pr  # or helper_pr
  use_cli_tools: true  # Enable Qwen CLI for better patches
  format_after_fix: true

# Exclude certain paths
exclude_paths:
  - '**/*.lock'
  - 'vendor/**'
  - 'node_modules/**'

# Bot-specific settings
bot_settings:
  code-reviewer:
    process_all: true
    auto_apply_suggestions: true
```

---

## 🔧 Advanced Features

### Enable Iterative Patch Generation

The new iterative generator automatically retries with different strategies:

```typescript
// In your code or agent.ts configuration
import { createEnhancedPatchIntegration } from './scripts/enhanced-patch-integration';

const integration = createEnhancedPatchIntegration(gitOps, {
  useIterativeGenerator: true,  // Enable retry logic
  useQwenFullFile: true,         // Enable full-file editing
  maxRounds: 5,                  // Try up to 5 times
  maxLlmRetries: 2,              // Retry LLM 2 times
  timeoutPerRound: 120000,       // 2 minutes per round
  enableEnhancedLogging: true,   // Capture thinking logs
  enablePersistentState: true,   // Save state for recovery
  logDir: './logs'
});

// Use for patch generation
const result = await integration.generatePatch(request, level, commentId);
```

### Use Qwen Full-File Mode

For complex fixes that require broader context:

```typescript
import { QwenFullFileSession } from './scripts/qwen-full-file-session';

const session = new QwenFullFileSession({
  repo: 'owner/repo',
  pr: 123,
  commitSha: 'abc123def',
  targetFile: 'src/complex-module.ts',
  startLine: 50,
  endLine: 100,
  reviewComment: 'Refactor this to use async/await',
  suggestedFixes: ['const result = await fetchData();'],
  gitOps: gitOpsInstance,
  maxRounds: 3,
  timeoutMs: 180000  // 3 minutes
});

const result = await session.execute();
console.log(result.patch);  // Unified diff
console.log(result.thinking);  // LLM reasoning
```

### Enhanced Error Analysis

Get detailed visual diffs when patches fail:

```typescript
import { PatchErrorAnalyzer } from './scripts/patch-error-analyzer';

const analyzer = new PatchErrorAnalyzer();

// Analyze error
const analysis = analyzer.analyzeGitError(
  'error: patch failed: src/file.ts:42',
  patchContent,
  fileContent
);

// Generate visual diff
const highlight = analyzer.generateDiffHighlight(
  patchContent,
  fileContent,
  'src/file.ts'
);

console.log(highlight.visualDiff);
// Shows side-by-side comparison with mismatches highlighted
```

### Persistent State & Recovery

Never lose work due to crashes:

```typescript
import { PersistentPatchStateManager } from './scripts/persistent-patch-state';

const stateManager = new PersistentPatchStateManager();

// On startup, recover pending work
const recovery = stateManager.recoverPendingWork();
console.log(recovery.recoveryReport);

// Retry failed patches
const retried = stateManager.retryFailedPatches('owner/repo', 123);

// Get state for specific comment
const state = stateManager.getStateForComment('owner/repo', 123, 'comment-id');
```

### Enhanced Logging

Capture all LLM thinking and generate reports:

```typescript
import { createSessionLogger } from './scripts/enhanced-logging';

const logger = createSessionLogger({
  sessionId: `pr-123-${Date.now()}`,
  logDir: './logs',
  captureThinking: true,
  saveToFile: true
});

// Log events
logger.info('PATCH', 'Starting generation', { repo: 'owner/repo' });
logger.thinking('Analyzing code structure...', { file: 'src/index.ts' });
logger.logPatchAttempt('owner/repo', 123, 'src/index.ts', 1, 'iterative', true);

// Export report
const reportPath = logger.saveSessionReport();
console.log('Report saved to:', reportPath);
```

---

## 🤖 n8n Integration

### Setup Webhook Handler

```bash
# Use enhanced handler with proper auth
node n8n-integration/n8n-webhook-handler-enhanced.js
```

### n8n Workflow Configuration

1. **Webhook Node** (GitHub trigger)
   - HTTP Method: POST
   - Path: `/webhook`
   - Respond: Immediately

2. **Code Node** (Prepare webhook)
```javascript
// Prepare webhook data for PR Autopilot
const webhookData = {
  body: $json.body,
  headers: $request.headers,
  rawBody: $request.rawBody,
  queuedAt: Date.now()
};

return webhookData;
```

3. **Execute Command Node**
```bash
node /path/to/n8n-webhook-handler-enhanced.js
```

### Agent Lifecycle Management

Auto-start/stop agent based on queue:

```bash
# Start lifecycle manager
node n8n-integration/agent-lifecycle-manager.js &

# Configuration
export AGENT_PORT=3000
export QUEUE_DIR=/tmp/pr-autopilot-queue
export IDLE_TIMEOUT_MS=60000  # Stop after 1 minute idle
```

---

## 🧪 Testing

### Run Tests

```bash
# All tests
bun test

# Unit tests only
bun run test:unit

# Specific test file
bun test tests/unit/iterative-patch-generator.test.ts

# With coverage
bun run test:coverage
```

### Write Custom Tests

```typescript
import { describe, it, expect } from 'vitest';
import { IterativePatchGenerator } from '../scripts/iterative-patch-generator';

describe('My Custom Test', () => {
  it('should handle my use case', async () => {
    const generator = new IterativePatchGenerator(gitOps);
    const result = await generator.generatePatchIterative(request, 2);
    
    expect(result.success).toBe(true);
    expect(result.patch).toContain('expected change');
  });
});
```

---

## 🐛 Troubleshooting

### Common Issues

#### "Patch generation failed after N rounds"

**Solution:**
1. Check logs: `cat logs/session-*.md`
2. Review thinking output for LLM reasoning
3. Try increasing `maxRounds` in options
4. Enable Qwen full-file mode for complex fixes

#### "Webhook signature verification failed"

**Solution:**
1. Verify `WEBHOOK_SECRET` matches GitHub webhook secret
2. Check raw body is being preserved in n8n
3. Ensure headers are forwarded correctly

#### "Agent won't start"

**Solution:**
```bash
# Check if port is in use
lsof -i :3000

# Kill existing process
kill -9 $(lsof -t -i :3000)

# Check environment variables
echo $GITHUB_TOKEN
echo $WEBHOOK_SECRET

# Try manual start with debug
DEBUG=true bun run scripts/agent.ts
```

#### "Queue not processing"

**Solution:**
```bash
# Check queue directory
ls -la /tmp/pr-autopilot-queue/

# Check agent health
curl http://localhost:3000/health

# Restart lifecycle manager
pkill -f agent-lifecycle-manager
node n8n-integration/agent-lifecycle-manager.js &
```

### Debug Mode

Enable verbose logging:

```bash
DEBUG=true bun run scripts/agent.ts
```

### View Logs

```bash
# Latest session report
cat logs/session-*-report.md

# Thinking logs
cat logs/session-*-thinking.jsonl

# All logs (JSONL format)
cat logs/session-*.jsonl | jq .
```

---

## 📊 Monitoring

### Health Check Endpoint

```bash
curl http://localhost:3000/health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00Z",
  "queue": {
    "length": 5,
    "processing": 2,
    "jobs": [
      { "id": "job-123", "type": "process_pr", "repo": "owner/repo", "pr": 42 }
    ]
  }
}
```

### Queue Status

```bash
bun run agent status
```

### Session Reports

```bash
# List all session reports
ls -la logs/*-report.md

# View latest report
tail -f logs/latest-report.md
```

---

## 🎯 Best Practices

### 1. Configure Risk Levels Appropriately

```yaml
# For production repos
autofix:
  risk_level: low  # Require approval for risky changes

# For internal tools
autofix:
  risk_level: medium  # Auto-apply most fixes

# For test repos
autofix:
  risk_level: high  # Auto-apply everything
```

### 2. Use Allowed Bots Wisely

```yaml
autofix:
  allowed_bots:
    - code-reviewer[bot]  # Trusted bot
    - security-bot[bot]   # Security fixes
    
# Don't auto-apply unknown bots
```

### 3. Enable Batching for Large PRs

```yaml
autofix:
  batching:
    enabled: true
    max_wait_ms: 5000  # Wait 5 seconds to batch
    max_comments_per_commit: 10
```

### 4. Format After Fixes

```yaml
autofix:
  format_after_fix: true  # Run prettier/eslint after applying
```

### 5. Monitor and Alert

Set up monitoring for:
- Queue length > 100
- Patch failure rate > 50%
- Agent downtime > 5 minutes

---

## 📚 Additional Resources

- [Full Documentation](IMPROVEMENTS.md)
- [API Reference](scripts/types.ts)
- [Test Examples](tests/unit/)
- [GitHub App Setup](scripts/setup-github-app.ts)

## 🆘 Getting Help

1. Check [IMPROVEMENTS.md](IMPROVEMENTS.md) for detailed docs
2. Review session logs in `logs/`
3. Enable debug mode: `DEBUG=true`
4. Open an issue with session report attached

---

## ✅ Checklist for First Run

- [ ] Installed dependencies
- [ ] Configured `.env` with GitHub token
- [ ] Set `WEBHOOK_SECRET`
- [ ] Started agent: `bun run agent`
- [ ] Tested health endpoint: `curl localhost:3000/health`
- [ ] Processed test PR successfully
- [ ] Reviewed logs in `logs/`
- [ ] Configured repository YAML file
- [ ] (Optional) Set up n8n integration
- [ ] (Optional) Enabled Qwen full-file mode

Congratulations! You're now ready to use PR Autopilot with all the enhanced features! 🎉
