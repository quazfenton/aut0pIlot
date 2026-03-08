# Unused/Deprecated Scripts

This folder contains scripts that have been superseded, orphaned, or are no longer wired into the main production flow.

## Files in This Folder

### Superseded by New Implementation
- **`qwen-interactive-session.ts`** → Replaced by consolidated `qwen-interactive-session.ts` in `/scripts/`
- **`qwen-coder-session.ts`** → Merged into `qwen-interactive-session.ts`
- **`qwen-full-file-session.ts`** → Merged into `qwen-interactive-session.ts`
- **`enhanced-qwen-session.ts`** → Functionality merged into `qwen-interactive-session.ts`

### Never Wired Into Production
- **`enhanced-agent-integration.ts`** → Created but never integrated into `agent.ts`
- **`enhanced-patch-integration.ts`** → Created but never integrated into `agent.ts`
- **`pending-patch-manager.ts`** → Created but never used

### Test Reference Only
- **`robust-patch-generator.ts`** → Only imported by `tests/comprehensive-enhanced.test.ts`
- **`patch-validator.ts`** → Validation moved to `utils/diff-utils.ts`

### Backup/Copy Files
- **`pgeneratorCopy2.ts`** → Backup copy of patch-generator.ts

## Production Files (NOT in this folder)

The following are the **active production files**:

### Core Production
- `agent.ts` - Main entry point
- `patch-generator.ts` - Core patch generation
- `iterative-patch-generator.ts` - Iterative retry logic
- `qwen-interactive-session.ts` - Qwen CLI integration
- `review-parser.ts` - Review comment parsing
- `config-loader.ts` - Configuration loading
- `git-ops.ts` - Git operations
- `state-machine.ts` - PR state management
- `comment-tracker.ts` - Comment tracking
- `approval-manager.ts` - Approval workflow
- `queue.ts` - Job queue

### Utilities
- `utils/diff-utils.ts` - Professional diff generation (uses `diff` library)
- `utils/code-quality-checker.ts` - Code quality validation
- `utils/patch-metrics.ts` - Patch metrics and reporting
- `utils/log-analyzer.ts` - Log analysis and recommendations

### CLI Tools (Standalone)
- `redeliver-failed-webhooks.ts` - Webhook redelivery tool
- `reapply-fixes.ts` - Fix reapplication tool

## Migration Guide

If you need functionality from these files:

| Old File | New File |
|----------|----------|
| `qwen-interactive.ts` | `qwen-interactive-session.ts` |
| `qwen-coder-session.ts` | `qwen-interactive-session.ts` |
| `qwen-full-file-session.ts` | `qwen-interactive-session.ts` |
| `enhanced-qwen-session.ts` | `qwen-interactive-session.ts` |
| `patch-validator.ts` | `utils/diff-utils.ts` |
| `robust-patch-generator.ts` | `iterative-patch-generator.ts` |

## Why Not Delete?

These files are kept for:
1. **Reference** - May contain useful patterns or approaches
2. **Test compatibility** - Some tests still import from these files
3. **Historical context** - Shows evolution of the codebase
4. **Fallback** - Can be restored if needed

## Cleanup Date

Files moved: March 7, 2026

Review and consider permanent deletion after 90 days if no issues arise.
