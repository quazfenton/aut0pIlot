# QWEN_DISCOVERY_MODE Configuration

## Default Behavior (Now Enabled)

As of March 7, 2026, `QWEN_DISCOVERY_MODE` is **enabled by default**.

This means the PR Autopilot will use the enhanced `IterativePatchGenerator` with:
- Full project context discovery
- Multi-file change detection
- Import/export dependency analysis
- Iterative refinement (up to 5 rounds)
- Code formatting integration
- Professional diff generation via `diff` library

## Environment Variable

```bash
# Enable (DEFAULT - no need to set)
# QWEN_DISCOVERY_MODE=true  # This is the default

# Disable (only if you want faster but less thorough patch generation)
QWEN_DISCOVERY_MODE=false
```

## What Changes With Discovery Mode

### Before (QWEN_DISCOVERY_MODE=false)
```
Review Comment → LLM Prompt → Single Patch Attempt → Apply/Fail
```

### After (QWEN_DISCOVERY_MODE=true, DEFAULT)
```
Review Comment → Project Analysis → Multi-file Discovery → 
Iterative Editing (up to 5 rounds) → Validation → Formatting → Apply
```

## Benefits

1. **Better Context**: Qwen sees the entire project structure, not just one file
2. **Multi-file Fixes**: Automatically detects when related files need updates
3. **Import Handling**: Adds/updates imports as needed
4. **Higher Success Rate**: Multiple rounds to fix issues
5. **Professional Diffs**: Uses `diff` library for proper unified diff format
6. **Code Quality**: Automatic formatting with prettier

## Performance Impact

| Metric | Disabled | Enabled (Default) |
|--------|----------|-------------------|
| Patch Generation Time | ~10-30s | ~30-120s |
| Success Rate | ~60% | ~85% |
| Multi-file Support | ❌ | ✅ |
| Import Updates | ❌ | ✅ |

## When to Disable

You might want to set `QWEN_DISCOVERY_MODE=false` if:
- You need very fast patch generation
- You're only making simple single-line changes
- You have your own formatting pipeline
- You're in a resource-constrained environment

## Implementation Details

The setting is checked in `scripts/patch-generator.ts`:

```typescript
// QWEN_DISCOVERY_MODE defaults to true - set to 'false' to disable
const qwenDiscoveryMode = process.env.QWEN_DISCOVERY_MODE !== 'false';

if (qwenDiscoveryMode && fileContent && patchRequest) {
  // Use IterativePatchGenerator with full project context
  const result = await this.iterativeGenerator.generatePatchIterative(
    patchRequest, 2, {
      maxRounds: 5,
      maxLlmRetries: 2,
      useQwenInteractive: true,
      enableFormatting: true,
      useFullWorkspace: true,
      timeoutPerRound: 180000
    }
  );
}
```

## Related Files

- `scripts/patch-generator.ts` - Main integration point
- `scripts/iterative-patch-generator.ts` - Iterative retry logic
- `scripts/qwen-interactive-session.ts` - Qwen CLI integration
- `scripts/utils/diff-utils.ts` - Professional diff generation
- `scripts/utils/code-quality-checker.ts` - Code quality validation
- `scripts/utils/patch-metrics.ts` - Patch metrics and reporting
