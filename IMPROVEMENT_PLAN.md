

## ✅ NEW: Qwen Coder Session & Pending Patch Manager

### Qwen Coder Session (`qwen-coder-session.ts`)
- **Full Context Integration**: Qwen receives complete review comment JSON with:
  - Full file content (not just diff lines)
  - Suggested Fixes section as starting point
  - Committable Suggestions section
  - Previous LLM attempt with error explanation
- **Multi-Round Editing**: Works like a coding CLI agent:
  - Can read full files
  - Makes edits in multiple rounds
  - Git pushes end result
- **JSON Response Format**: Structured output with:
  - `thinking`: Qwen's reasoning about the fix
  - `edits`: Array of file edits with exact line numbers and content
  - `additionalFiles`: Other files that need changes
- **Thinking Capture**: All Qwen thinking output saved for debugging

### Pending Patch Manager (`pending-patch-manager.ts`)
- **No Lost Patches**: Patches saved to `.pr-autopilot/pending-patches.json`
- **Status Tracking**: `pending` | `committed` | `failed`
- **Commit Recovery**: If script crashes, pending patches are recovered on next run
- **Auto-Cleanup**: Removes committed/old patches after 7 days

### Enhanced Logging
- Diff failures show exact line mismatches
- Qwen thinking output captured for debugging
- Status updates saved to comment JSON files

### Usage
```bash
# Reapply failed fixes with Qwen
bun run scripts/reapply-fixes.ts .pr-autopilot/comments.json --use-qwen

# Skip already committed comments (default)
bun run scripts/reapply-fixes.ts .pr-autopilot/comments.json --skip-committed

# Force reapply all
bun run scripts/reapply-fixes.ts .pr-autopilot/comments.json --force
```


# PR Autopilot Improvement Plan

## ✅ RECENTLY COMPLETED

### Comment Storage
- Changed from `/tmp/` to `.pr-autopilot/` in project
- Quality validation with line number checking

## 🔍 Log Analysis Findings (quazfenton/binG PR #18)

### Issues Identified:
1. **Comments saved to `/tmp/`** - Should be local for persistence
2. **Qwen not being called** - Falls through to API providers
3. **No commit validation** - Patches may have incorrect context
4. **Patch quality issues**:
   - Extra lines being removed
   - Trailing semicolons/whitespace
   - Context mismatches

### Fixes Applied:
1. ✅ Changed comment storage to `./.pr-autopilot/` (local)
2. ✅ Created `PatchValidator` class for robust validation
3. ✅ Added context verification (above/below line matching)
4. ✅ Added line count verification

## ✅ COMPLETED: Critical TSC Errors Fixed
- **agent.ts**: Moved variable declarations before try block
- **state-machine.ts**: Changed `setHelperBranch` parameter to `string | undefined`
- **patch-generator.ts**: Removed duplicate `extractCodeBlock` function

## ✅ COMPLETED: Test Infrastructure
- Created `vitest` test suite with 80 unit tests passing across 5 test files
- Coverage: queue, state-machine, review-parser, config-loader, patch-generator

## ✅ COMPLETED: Enhanced Qwen Interactive Session
- Created `qwen-interactive.ts` with comprehensive iterative session support
- **Features**:
  - Up to 10 iterations per comment (configurable)
  - Full project context loading (structure, configs, README, related files)
  - Multi-file edit detection and support
  - Automatic patch validation and repair
  - Context follow-up when Qwen needs more info
  - Guidance prompts when Qwen is stuck
  - Retry logic with exponential backoff
  - Session logging for debugging

## ✅ COMPLETED: Comment Tracking System
- Created `comment-tracker.ts` for persisting webhook comments to JSON files
- **Features**:
  - One JSON file per PR (`comments_<repo>_<pr>.json`)
  - Tracks status: `received` → `queued` → `processing` → `patch_generated` → `committed` / `failed`
  - Records status history with timestamps
  - Stores patch content and commit SHA when fixed
  - Provides stats (total, pending, fixed, failed)
  - Cleanup method for old files

## Key Issues from THEORETICAL.md (LLM Patch Generation)

### Problem: LLM Not Returning Valid Diff Format
The LLM often returns code blocks instead of unified diffs:
```
[PATCH] No valid diff format found in response
[PATCH] Could not extract valid patch from LLM response
```

### Root Causes Identified:
1. **Prompt ambiguity** - LLM not explicitly told to return unified diff
2. **Code block fallback** - System tries to build diff from code block but often fails
3. **Indentation issues** - Generated patches don't match original file indentation
4. **Corrupt patches** - "corrupt patch at line 3" errors from malformed hunks

### Solutions Implemented in patch-generator.ts:
1. `buildLLMPrompt` - Explicitly requests unified diff format
2. `extractPatchFromResponse` - Handles ```diff and ```patch blocks
3. `normalizePatchHeaders` - Injects headers if missing
4. `qwenPostValidateIfEnabled` - Optional Qwen validation pass
5. `qwenIterateOnFailureIfEnabled` - Optional Qwen iteration on failure

### Remaining Improvements Needed:

#### 1. Enhanced LLM Prompt Engineering
```typescript
// Current prompt needs improvement:
prompt += `
Return the fixed code in a code block like this:
${'```'}
// your fixed code here
${'```'}
`;

// Should be:
prompt += `
Return ONLY a unified diff patch in this exact format:
--- a/${file}
+++ b/${file}
@@ -${startLine},${lineCount} +${startLine},${newLineCount} @@
 context line
-removed line
+added line
 context line
`;
```

#### 2. Better Indentation Preservation
- `restoreBaselineIndent` exists but needs more robust testing
- Consider using `diff-match-patch` library for better alignment

#### 3. Multi-file Change Detection
- ✅ `QWEN_DISCOVERY_MODE` - NOW ENABLED BY DEFAULT - Uses `IterativePatchGenerator` with full project context
- Should detect when changes in one file require updates elsewhere

#### 4. Retry Logic Improvements
- Add exponential backoff for LLM rate limits
- Better handling of HTTP_429 errors (already partially implemented)

## Implementation Progress

### Completed ✅
- [x] Fix TSC errors
- [x] Create test infrastructure
- [x] Add comprehensive unit tests
- [x] Add integration tests
- [x] Add E2E tests
- [x] Fix command injection vulnerabilities (P0)
- [x] Fix fake timers in tests
- [x] Fix edit ordering (bottom-to-top)
- [x] Fix JSON validation
- [x] Fix skipped comment state logic
- [x] Fix context validation
- [x] Fix comment metadata preservation
- [x] Fix repo name reconstruction

### In Progress
- [ ] Improving LLM prompt format requirements

---

## Files to Modify

1. `scripts/agent.ts` - Fix variable scope
2. `scripts/patch-generator.ts` - Fix duplicates, add cleanup, improve prompts
3. `scripts/types.ts` - Ensure type completeness
4. `tests/` - Create new test directory with comprehensive tests

## New Test Files to Create

```
tests/
├── unit/
│   ├── review-parser.test.ts
│   ├── patch-generator.test.ts
│   ├── git-ops.test.ts
│   ├── state-machine.test.ts
│   ├── queue.test.ts
│   └── config-loader.test.ts
├── integration/
│   ├── webhook-handling.test.ts
│   ├── pr-processing.test.ts
│   └── llm-integration.test.ts
├── e2e/
│   ├── full-pr-cycle.test.ts
│   └── multi-comment-batch.test.ts
└── setup.ts
```
