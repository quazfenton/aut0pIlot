# Enhanced PR Autopilot Integration Guide

## Overview

This guide describes the enhanced architecture for PR Autopilot that addresses the critical issues with patch generation failures, webhook authentication, and state management.

## Key Improvements

### 1. Enhanced Qwen CLI Integration

**Problem**: Current Qwen integration is limited to single-response patch generation, leading to high failure rates.

**Solution**: `enhanced-qwen-session.ts` provides:
- Interactive CLI mode with full repository context
- Multi-round editing capabilities (read, think, edit, validate)
- Learning from previous failed attempts
- Access to entire codebase for better context

**Usage**:
```typescript
import { EnhancedQwenSession, EnhancedQwenOptions } from './scripts/enhanced-qwen-session';

const options: EnhancedQwenOptions = {
  repo: 'owner/repo',
  pr: 123,
  commitSha: 'abc123',
  targetFile: 'src/file.ts',
  startLine: 10,
  endLine: 20,
  reviewComment: 'Fix this issue',
  previousAttempts: [...], // Learn from failures
  suggestedFixes: [...],
  gitOps
};

const session = new EnhancedQwenSession(options);
const result = await session.execute();
```

### 2. Robust Patch Generation

**Problem**: Single-shot LLM patch generation has ~80% failure rate due to formatting issues.

**Solution**: `robust-patch-generator.ts` implements a multi-layered approach:

1. **Mechanical Extraction**: Try GitHub suggestions first
2. **Traditional LLM**: Enhanced with failure history
3. **Enhanced Qwen CLI**: Interactive editing with full context
4. **Advanced Repair**: Multiple repair strategies

**Features**:
- Attempt history tracking
- Intelligent patch repair
- Validation at each step
- Fallback mechanisms

**Usage**:
```typescript
import { RobustPatchGenerator } from './scripts/robust-patch-generator';

const generator = new RobustPatchGenerator(gitOps);
const result = await generator.generateRobustPatch(request, level, useCliTools);
```

### 3. Enhanced Logging and Diff Analysis

**Problem**: Poor visibility into patch failures and no detailed error reporting.

**Solution**: `enhanced-logging.ts` provides:
- Structured logging with categories
- Detailed diff analysis
- Patch quality assessment
- Export capabilities

**Features**:
- Real-time console output with colors
- JSON log files for analysis
- Diff validation reports
- Change tracking

**Usage**:
```typescript
import { EnhancedLogger } from './scripts/enhanced-logging';

const logger = new EnhancedLogger(sessionId);
logger.logPatchAnalysis(diffAnalysis);
const summary = logger.getSummary();
```

### 4. Persistent Patch State Management

**Problem**: Lost patches when script crashes or restarts.

**Solution**: `persistent-patch-state.ts` implements:
- Durable state storage
- Recovery mechanisms
- Batch commit tracking
- Automatic cleanup

**Features**:
- Survives process restarts
- Tracks patch lifecycle
- Batch commit coordination
- Failure recovery

**Usage**:
```typescript
import { PersistentPatchStateManager } from './scripts/persistent-patch-state';

const stateManager = new PersistentPatchStateManager();
const patchState = stateManager.createPatchState(...);
stateManager.updatePatchStatus(id, 'APPLIED');
```

### 5. Enhanced Webhook Authentication

**Problem**: n8n webhook handler strips authentication headers.

**Solution**: `enhanced-webhook-handler.js` provides:
- Proper signature preservation
- GitHub webhook verification
- Queue fallback mechanism
- Better error handling

**Features**:
- Maintains original signatures
- Verifies GitHub webhooks
- Queues failed deliveries
- Comprehensive logging

## Integration Steps

### 1. Update Agent.ts

Replace the existing patch generation logic:

```typescript
// In agent.ts handleProcessJob method
import { RobustPatchGenerator } from './robust-patch-generator';
import { EnhancedLogger } from './enhanced-logging';
import { PersistentPatchStateManager } from './persistent-patch-state';

// Initialize components
const robustGenerator = new RobustPatchGenerator(this.gitOps);
const logger = new EnhancedLogger(`job-${job.id}`);
const stateManager = new PersistentPatchStateManager();

// For each comment:
const patchState = stateManager.createPatchState(
  job.repo, job.pr, comment.file, 
  comment.start_line, comment.end_line, comment.id
);

stateManager.updatePatchStatus(patchState.id, 'GENERATING');

const patchResult = await robustGenerator.generateRobustPatch(
  patchRequest, level, data.config.autofix.use_cli_tools
);

if (patchResult.success) {
  stateManager.updatePatchStatus(patchState.id, 'APPLIED', patchResult.patch);
  // Continue with git operations...
} else {
  stateManager.updatePatchStatus(patchState.id, 'FAILED', undefined, patchResult.error);
}
```

### 2. Update n8n Integration

Replace the webhook handler:

```bash
# Update n8n workflow to use enhanced handler
node n8n-integration/enhanced-webhook-handler.js
```

### 3. Environment Configuration

Add these environment variables:

```bash
# Enhanced features
ENABLE_ENHANCED_QWEN=true
ENABLE_ROBUST_PATCHING=true
ENABLE_PERSISTENT_STATE=true

# Logging
DEBUG=true
LOG_LEVEL=info

# Webhook authentication (required)
WEBHOOK_SECRET=your-github-webhook-secret
```

### 4. Package Updates

Update dependencies in package.json:

```json
{
  "dependencies": {
    "qwen-cli": "^1.0.0",
    "diff": "^5.0.0"
  }
}
```

## Migration Strategy

### Phase 1: Parallel Deployment
1. Deploy new components alongside existing ones
2. Enable enhanced features for specific repos only
3. Monitor success rates

### Phase 2: Gradual Rollout
1. Increase percentage of repos using enhanced features
2. Monitor performance metrics
3. Collect feedback

### Phase 3: Full Migration
1. Switch all repos to enhanced architecture
2. Remove old components
3. Update documentation

## Performance Improvements

### Expected Success Rate Increase
- **Current**: ~20% patch success rate
- **With Enhanced Qwen**: ~60% success rate
- **With Full Robust System**: ~85% success rate

### Failure Recovery
- **Automatic retry**: Up to 3 attempts with different strategies
- **State persistence**: No lost work on restart
- **Queue fallback**: Webhooks preserved during agent downtime

### Monitoring
- **Detailed logging**: Full visibility into patch generation process
- **State tracking**: Real-time status of all patches
- **Error analysis**: Common failure patterns identification

## Troubleshooting

### Common Issues

1. **Qwen CLI not found**
   ```bash
   npm install -g qwen-cli
   ```

2. **Permission denied on temp directories**
   ```bash
   export TMPDIR=/var/tmp/pr-autopilot
   mkdir -p $TMPDIR
   ```

3. **Webhook signature verification failing**
   - Ensure WEBHOOK_SECRET matches GitHub webhook secret
   - Check that enhanced-webhook-handler.js is being used

4. **State files not persisting**
   - Check temp directory permissions
   - Ensure process has write access to /tmp/pr-autopilot-state

### Debug Mode

Enable comprehensive debugging:

```bash
DEBUG=true LOG_LEVEL=debug bun run scripts/agent.ts
```

### Log Analysis

Export and analyze logs:

```typescript
const logger = new EnhancedLogger(sessionId);
const exportPath = logger.exportLogs();
console.log(`Logs exported to: ${exportPath}`);
```

## Testing

### Unit Tests
```bash
bun test scripts/enhanced-qwen-session.test.ts
bun test scripts/robust-patch-generator.test.ts
bun test scripts/persistent-patch-state.test.ts
```

### Integration Tests
```bash
bun test test-enhanced-integration.ts
```

### Load Testing
```bash
bun run test-load-enhanced.js
```

## Monitoring and Metrics

### Key Metrics to Track
1. **Patch Success Rate**: By method (mechanical, traditional, enhanced qwen)
2. **Average Attempts per Patch**: Target < 2.5
3. **Queue Processing Time**: Target < 30 seconds
4. **State Recovery Success**: Target > 95%

### Dashboard Integration
```typescript
import { PersistentPatchStateManager } from './persistent-patch-state';

const stateManager = new PersistentPatchStateManager();
const report = stateManager.generateReport();

// Send to monitoring system
sendMetrics(report.summary);
```

## Security Considerations

1. **Webhook Secrets**: Never log webhook secrets
2. **Temp Directory Cleanup**: Automatic cleanup of sensitive data
3. **API Keys**: Use environment variables, never hardcode
4. **Access Control**: Limit who can trigger enhanced features

## Future Enhancements

1. **ML-Based Patch Repair**: Train models on successful patches
2. **Multi-Repo Context**: Learn from fixes across repositories
3. **Real-time Collaboration**: Allow human intervention during patch generation
4. **Advanced Diff Algorithms**: Better context-aware patching

## Support

For issues with the enhanced architecture:
1. Check logs in `/tmp/pr-autopilot-logs/`
2. Review state in `/tmp/pr-autopilot-state/`
3. Enable debug mode for detailed output
4. Check GitHub webhook configuration

This enhanced architecture should significantly improve the reliability and success rate of automated patch generation while providing better visibility and recovery capabilities.
