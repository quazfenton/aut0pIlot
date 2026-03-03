# PR Autopilot - Improvement Plan Implementation

## Overview

This document describes the comprehensive improvements made to the PR Autopilot system for more robust automated code fix generation from GitHub PR review comments.

## Problems Addressed

1. **Patch generation failures** - LLMs often generated malformed diffs that failed to apply
2. **No error learning** - Previous failed attempts weren't used to improve subsequent tries
3. **Limited Qwen integration** - Qwen CLI wasn't being used to its full potential
4. **No crash recovery** - Pending work was lost if the script crashed
5. **Poor error diagnostics** - No visibility into why patches failed
6. **Webhook authentication issues** - Forwarded webhooks from n8n lost signature validation
7. **Agent lifecycle management** - No proper start/stop automation based on queue state
8. **Missing thinking logs** - LLM reasoning wasn't captured for debugging

## Architecture Improvements

### 1. Enhanced Qwen CLI Integration (`qwen-full-file-session.ts`)

**What it does:**
- Creates a full workspace with the target file and related context files
- Allows Qwen to read entire files, not just diff snippets
- Supports multiple rounds of editing with validation
- Captures thinking output for debugging
- Generates proper unified diffs from full-file edits

**Key features:**
```typescript
interface QwenFullFileOptions {
  repo: string;
  pr: number;
  targetFile: string;
  startLine: number;
  endLine: number;
  reviewComment: string;
  suggestedFixes?: string[];
  committableSuggestions?: string[];
  previousAttempts?: Array<{ patch, error, llm }>;
  maxRounds?: number;
  timeoutMs?: number;
}
```

**Usage:**
```typescript
const session = new QwenFullFileSession({
  repo: 'owner/repo',
  pr: 123,
  commitSha: 'abc123',
  targetFile: 'src/index.ts',
  startLine: 10,
  endLine: 20,
  reviewComment: 'Fix the off-by-one error',
  gitOps: gitOpsInstance,
  maxRounds: 3,
  timeoutMs: 180000
});

const result = await session.execute();
// result.success, result.patch, result.thinking
```

### 2. Iterative Patch Generation (`iterative-patch-generator.ts`)

**What it does:**
- Implements a multi-round retry strategy
- Learns from previous failures
- Tries multiple approaches (mechanical → traditional LLM → Qwen full-file → repair)
- Provides detailed error feedback to subsequent attempts

**Retry Strategy:**
```
Round 1: Mechanical extraction (GitHub suggestions)
Round 2: Traditional LLM with context
Round 3: Qwen full-file session
Round 4: Traditional LLM with error feedback
Round 5: Final repair attempt
```

**Key features:**
- Automatic fallback between methods
- Error analysis feeds into next attempt
- Validates each patch before accepting
- Records full attempt history for debugging

**Usage:**
```typescript
const generator = new IterativePatchGenerator(gitOps);

const result = await generator.generatePatchIterative(request, level, {
  maxRounds: 5,
  maxLlmRetries: 3,
  useQwenFullFile: true,
  timeoutPerRound: 120000
});
```

### 3. Enhanced Error Analysis (`patch-error-analyzer.ts`)

**What it does:**
- Analyzes git apply errors to determine root cause
- Generates visual side-by-side diffs showing mismatches
- Provides actionable suggestions for fixes
- Creates detailed error reports for LLM feedback

**Error Types Detected:**
- `line_mismatch` - Context lines don't match file
- `context_mismatch` - Surrounding code is different
- `whitespace` - Tab/space or trailing whitespace issues
- `hunk_header` - Malformed @@ header
- `missing_file` - Target file doesn't exist

**Visual Diff Output:**
```
╔════════════════════════════════════════════════════════════════╗
║                    PATCH vs FILE COMPARISON                     ║
╚════════════════════════════════════════════════════════════════╝

📄 FILE CONTENT (with mismatches highlighted):
──────────────────────────────────────────────────────────────────
  10 | function hello() {
  11 |   console.log('world');
>>12 |   console.log('universe');
     | Expected: console.log('hello');
     | ❌ MISMATCH (type: context)
  13 | }

📊 SUMMARY:
Total mismatches: 1
File lines shown: 5
Patch lines: 3
```

### 4. Persistent Patch State (`persistent-patch-state.ts`)

**What it does:**
- Saves patch generation state to disk
- Recovers pending work after crashes
- Tracks batch commits for bulk operations
- Provides recovery reports on startup

**State Machine:**
```
PENDING → GENERATING → GENERATED → VALIDATING → APPLYING → APPLIED → COMMITTED
                     ↓              ↓           ↓
                   FAILED ←───────┴───────────┘
```

**Recovery:**
```typescript
const stateManager = new PersistentPatchStateManager();
const recovery = stateManager.recoverPendingWork();

console.log(recovery.recoveryReport);
// Shows pending patches, batches, and failed items

// Retry failed patches
const retried = stateManager.retryFailedPatches('owner/repo', 123);
```

### 5. Enhanced n8n Integration

#### Webhook Handler (`n8n-webhook-handler-enhanced.js`)

**Improvements:**
- Preserves raw body for signature verification
- Properly forwards all GitHub headers
- Validates signatures before processing
- Queues webhooks when agent is unavailable
- Better error handling and logging

**Usage in n8n:**
```javascript
// n8n Code node
const webhookData = {
  body: $json.body,
  headers: $request.headers,
  rawBody: $request.rawBody
};

return webhookData;
```

#### Agent Lifecycle Manager (`agent-lifecycle-manager.js`)

**What it does:**
- Automatically starts agent when queue has items
- Monitors agent health via /health endpoint
- Stops agent after idle timeout to save resources
- Prevents multiple instances
- Handles graceful shutdown

**Configuration:**
```bash
AGENT_PORT=3000
QUEUE_DIR=/tmp/pr-autopilot-queue
IDLE_TIMEOUT_MS=60000
HEALTH_CHECK_INTERVAL_MS=5000
AGENT_START_TIMEOUT_MS=30000
```

**Start the manager:**
```bash
node n8n-integration/agent-lifecycle-manager.js &
```

### 6. Enhanced Logging (`enhanced-logging.ts`)

**What it does:**
- Captures all LLM thinking output
- Logs patch attempts with success/failure tracking
- Exports session reports in Markdown
- Saves logs in JSONL format for analysis

**Usage:**
```typescript
import { createSessionLogger } from './enhanced-logging';

const logger = createSessionLogger({
  sessionId: `pr-123-${Date.now()}`,
  logDir: './logs',
  captureThinking: true,
  saveToFile: true
});

logger.info('PATCH', 'Starting patch generation', { repo, pr, file });
logger.thinking(thinkingContent, { file: 'src/index.ts' });
logger.logPatchAttempt(repo, pr, file, attempt, method, success, error, patch);

// Export report
const reportPath = logger.saveSessionReport();
```

**Session Report Output:**
```markdown
# PR Autopilot Session Report
Session ID: pr-123-1234567890
Generated: 2024-01-15T10:30:00Z

## Summary
- Total log entries: 45
- Thinking outputs: 12
- Errors: 3
- Warnings: 5
- Successes: 8

## Patch Attempts
- owner/repo#123:src/index.ts
  - Method: traditional_llm
  - Result: error
  - Error: Context does not match...

## Thinking Logs
### Round 1
Timestamp: 2024-01-15T10:30:05Z
File: src/index.ts
```
The LLM is analyzing the code structure...
```
```

## File Structure

```
pr-autopilot/
├── scripts/
│   ├── agent.ts                        # Main agent (unchanged)
│   ├── patch-generator.ts              # Original patch generator (unchanged)
│   ├── iterative-patch-generator.ts    # NEW: Iterative retry logic
│   ├── qwen-full-file-session.ts       # NEW: Full-file Qwen integration
│   ├── qwen-coder-session.ts           # Original Qwen session (unchanged)
│   ├── enhanced-qwen-session.ts        # Enhanced Qwen (improved)
│   ├── patch-error-analyzer.ts         # ENHANCED: Visual diff highlighting
│   ├── patch-validator.ts              # Original validator (unchanged)
│   ├── robust-patch-generator.ts       # Original robust generator (unchanged)
│   ├── persistent-patch-state.ts       # ENHANCED: Recovery reports
│   ├── pending-patch-manager.ts        # Original manager (unchanged)
│   ├── enhanced-logging.ts             # NEW: Thinking capture & reports
│   ├── review-parser.ts                # Original parser (unchanged)
│   ├── git-ops.ts                      # Original git ops (unchanged)
│   ├── queue.ts                        # Original queue (unchanged)
│   ├── types.ts                        # Type definitions (unchanged)
│   └── config-loader.ts                # Original config loader (unchanged)
├── n8n-integration/
│   ├── n8n-webhook-handler.js          # Original handler (unchanged)
│   ├── n8n-webhook-handler-enhanced.js # NEW: Enhanced with auth
│   ├── process-queued-webhooks.js      # Queue processor (unchanged)
│   ├── check-agent-status.js           # Status checker (unchanged)
│   └── agent-lifecycle-manager.js      # NEW: Auto start/stop
├── tests/
│   └── unit/
│       └── iterative-patch-generator.test.ts  # NEW: Comprehensive tests
└── IMPROVEMENTS.md                     # This file
```

## Configuration

### Environment Variables

```bash
# GitHub Authentication
GITHUB_TOKEN=your_personal_access_token
# OR
GITHUB_APP_ID=your_app_id
GITHUB_PRIVATE_KEY=your_private_key
GITHUB_APP_INSTALLATION_ID=installation_id

# Webhook Security
WEBHOOK_SECRET=your_webhook_secret

# LLM APIs
GEMINI_API_KEY=your_gemini_key
MISTRAL_API_KEY=your_mistral_key
ZO_CLIENT_IDENTITY_TOKEN=your_zo_token

# Agent Configuration
AGENT_PORT=3000
AGENT_HOST=localhost

# Queue Configuration
QUEUE_DIR=/tmp/pr-autopilot-queue
PROCESSED_DIR=/tmp/pr-autopilot-processed

# Lifecycle Manager
IDLE_TIMEOUT_MS=60000
HEALTH_CHECK_INTERVAL_MS=5000
AGENT_START_TIMEOUT_MS=30000

# Logging
DEBUG=true
LOG_DIR=./logs
```

## Usage Examples

### Manual Patch Generation

```bash
# Start the agent
bun run scripts/agent.ts

# Enqueue a PR for processing
bun run scripts/agent.ts process owner/repo 123

# Check status
bun run scripts/agent.ts status
```

### Using Enhanced Features Programmatically

```typescript
import { IterativePatchGenerator } from './scripts/iterative-patch-generator';
import { GitOps } from './scripts/git-ops';
import { createSessionLogger } from './scripts/enhanced-logging';

// Setup
const gitOps = new GitOps(process.env.GITHUB_TOKEN);
const logger = createSessionLogger({ sessionId: 'manual-test' });
const generator = new IterativePatchGenerator(gitOps);

// Generate patch with all enhancements
const request: PatchRequest = {
  repo: 'owner/repo',
  pr: 123,
  commit_sha: 'abc123',
  file: 'src/index.ts',
  start_line: 10,
  end_line: 20,
  content: 'Fix the off-by-one error',
  suggestions: [
    { code: 'const x = 1;', source: 'github', section: 'suggestion' }
  ]
};

const result = await generator.generatePatchIterative(request, 2, {
  maxRounds: 5,
  useQwenFullFile: true
});

if (result.success) {
  console.log('Patch generated:', result.patch);
  logger.success('PATCH', 'Generated successfully', { 
    patchLength: result.patch.length 
  });
} else {
  console.error('Patch failed:', result.error);
  logger.error('PATCH', 'Generation failed', { error: result.error });
  
  // Export session report for debugging
  const reportPath = logger.saveSessionReport();
  console.log('Report saved to:', reportPath);
}
```

### Recovery After Crash

```typescript
import { PersistentPatchStateManager } from './scripts/persistent-patch-state';

const stateManager = new PersistentPatchStateManager();

// On startup, check for pending work
const recovery = stateManager.recoverPendingWork();

console.log(recovery.recoveryReport);

// Retry failed patches
if (recovery.failedPatches.length > 0) {
  console.log(`Retrying ${recovery.failedPatches.length} failed patches...`);
  stateManager.retryFailedPatches();
}

// Process pending batches
for (const batch of recovery.pendingBatches) {
  console.log(`Processing batch ${batch.id} with ${batch.patches.length} patches`);
  // Process batch...
}
```

## Testing

Run the comprehensive test suite:

```bash
# All tests
bun test

# Unit tests only
bun run test:unit

# Specific test file
bun test tests/unit/iterative-patch-generator.test.ts
```

### Test Coverage

The test suite covers:
- Mechanical extraction from GitHub suggestions
- Patch validation (valid and invalid cases)
- Error analysis and diff highlighting
- Iterative retry logic
- Complex scenarios (multi-line, unicode, etc.)
- Crash recovery
- Queue processing

## Migration Guide

### Existing Deployments

The improvements are backward compatible. To enable new features:

1. **Enable iterative patch generation:**
   ```typescript
   // In your patch generation code
   const generator = new IterativePatchGenerator(gitOps);
   const result = await generator.generatePatchIterative(request, level, {
     useQwenFullFile: true  // Enable Qwen full-file mode
   });
   ```

2. **Enable enhanced logging:**
   ```typescript
   import { globalLogger } from './enhanced-logging';
   
   // Replace console.log calls
   globalLogger.info('CATEGORY', 'Message');
   ```

3. **Use lifecycle manager:**
   ```bash
   # Instead of running agent directly
   node n8n-integration/agent-lifecycle-manager.js &
   ```

4. **Update n8n webhook handler:**
   ```bash
   # Use enhanced handler
   node n8n-integration/n8n-webhook-handler-enhanced.js
   ```

## Performance Considerations

- **Qwen full-file mode** is slower but more accurate (use for complex fixes)
- **Iterative retry** may take longer but has higher success rate
- **Enhanced logging** writes to disk (disable in production if needed)
- **Lifecycle manager** keeps agent running (configure idle timeout)

## Troubleshooting

### Patch Generation Fails

1. Check the session report: `logs/session-*.md`
2. Review thinking logs for LLM reasoning
3. Look at visual diff in error reports
4. Try increasing `maxRounds` or `timeoutPerRound`

### Agent Won't Start

1. Check if port is already in use: `lsof -i :3000`
2. Verify environment variables are set
3. Check logs for startup errors
4. Try manual start: `bun run scripts/agent.ts`

### Webhooks Not Processing

1. Verify signature validation: check `WEBHOOK_SECRET`
2. Check queue directory permissions
3. Review n8n handler logs
4. Test webhook forwarding manually

### Memory Issues

1. Reduce `maxRounds` in iterative generator
2. Lower concurrency in queue processor
3. Enable state persistence for crash recovery
4. Configure shorter idle timeout

## Future Improvements

- [ ] Add support for multiple LLM providers in parallel
- [ ] Implement fuzzy patch matching for near-misses
- [ ] Add webhook signature caching for performance
- [ ] Create web dashboard for monitoring
- [ ] Add metrics and alerting
- [ ] Support for GitHub App authentication
- [ ] Automatic rollback on failed CI checks

## Credits

All improvements maintain backward compatibility with existing functionality.
