# PR Autopilot - Configuration & Usage Guide

## 🚀 Enabling Qwen Iterative Mode (Full Qwen Mode)

### Method 1: Configuration File (Recommended)

Create or update `.pr-autopilot.config.json` in your repository root:

```json
{
  "autofix": {
    "enabled": true,
    "use_cli_tools": true,
    "use_iterative_generator": true,
    "use_qwen_full_file": true,
    "max_qwen_rounds": 5,
    "qwen_timeout_ms": 180000
  }
}
```

### Method 2: Environment Variables

```bash
# Enable Qwen iterative mode
export PR_AUTOPILOT_USE_QWEN=true
export PR_AUTOPILOT_ITERATIVE=true
export PR_AUTOPILOT_QWEN_ROUNDS=5
export PR_AUTOPILOT_QWEN_TIMEOUT=180000
```

### Method 3: Code Integration

In your agent.ts or custom script:

```typescript
import { createEnhancedPatchIntegration } from './scripts/enhanced-patch-integration';

const integration = createEnhancedPatchIntegration(gitOps, {
  useIterativeGenerator: true,    // Enable iterative retry logic
  useQwenFullFile: true,          // Enable full Qwen CLI mode
  maxRounds: 5,                   // Try up to 5 times
  maxLlmRetries: 3,               // Retry LLM 3 times
  timeoutPerRound: 120000,        // 2 minutes per round
  enableEnhancedLogging: true,    // Capture thinking logs
  enablePersistentState: true     // Save state for recovery
});
```

### Verify Qwen Mode is Enabled

Check the logs when processing:

```
[ITERATIVE-PATCH] ══ Starting iterative patch generation for file.ts ══
[STEP] Max rounds: 5, Max LLM retries: 3
[QWEN-FULL-MODE] Starting full-file Qwen session
```

---

## ✅ Patch Approval System

### Overview

Patches are automatically marked for approval when they:
- Modify sensitive files (`.env*`, `*secret*`, `*credential*`)
- Contain risky patterns (`password`, `api_key`, `secret`)
- Include risk keywords (`security`, `authentication`, `breaking change`)
- Are flagged by risk level settings

### Approval Commands

Comment on the PR with these commands:

#### Approve a Patch
```
/pr-autopilot approve <approval-id>
```

#### Reject a Patch
```
/pr-autopilot reject <approval-id> [reason]
```

#### List Pending Approvals
```
/pr-autopilot approvals
```

#### View Approval Details
```
/pr-autopilot approval <approval-id>
```

### Example Workflow

1. **Bot posts approval request:**
   ```
   ⚠️ **Patch Requires Approval**
   
   **File**: `src/config/database.ts:45-67`
   **Reason**: risky_file (matches pattern: **/database.*)
   **Approval ID**: approval-my-repo-123-abc456
   
   To approve: /pr-autopilot approve approval-my-repo-123-abc456
   To reject: /pr-autopilot reject approval-my-repo-123-abc456 [reason]
   ```

2. **Reviewer approves:**
   ```
   /pr-autopilot approve approval-my-repo-123-abc456
   ```

3. **Bot confirms:**
   ```
   ✅ **Patch Approved**
   
   **File**: `src/config/database.ts:45-67`
   **Approved by**: @reviewer
   **Time**: 2024-01-15 10:30 AM
   
   _Patch will be applied in the next processing cycle._
   ```

### Who Can Approve?

By default, these users can approve:
- Repository owners
- Users with admin/maintain/push permissions
- Users listed in `approval_settings.approvers`

Configure in `.pr-autopilot.config.json`:

```json
{
  "approval_settings": {
    "approvers": [
      "@owner",
      "@admin",
      "@specific-user"
    ],
    "approval_methods": [
      "comment_command",
      "reaction",
      "label"
    ]
  }
}
```

### Alternative Approval Methods

#### 1. Reaction Approval
React to the approval comment with 👍 or ✅

#### 2. Label Approval
Add the `pr-autopilot-approved` label to the PR

#### 3. GitHub Review Approval
Submit a GitHub review with "Approve" status

---

## 🔧 Configuration Options

### Full Configuration Example

```json
{
  "autofix": {
    "enabled": true,
    "max_iterations": 5,
    "risk_level": "medium",
    "allowed_bots": ["coderabbitai", "cubic-dev-ai"],
    "branch_strategy": "update_same_pr",
    "require_approval_for_risky": true,
    
    "✨ Qwen Settings":
    "use_cli_tools": true,
    "use_iterative_generator": true,
    "use_qwen_full_file": true,
    "max_qwen_rounds": 5,
    "qwen_timeout_ms": 180000,
    
    "format_after_fix": true,
    "batching": {
      "enabled": true,
      "max_wait_ms": 5000,
      "max_comments_per_commit": 10
    }
  },
  
  "approval_settings": {
    "require_approval_for": {
      "files": [
        "**/*.env*",
        "**/*secret*",
        "**/*credential*",
        "**/config/production.*",
        "**/database.*",
        "**/auth.*"
      ],
      "patterns": [".*password.*", ".*api_key.*", ".*secret.*"],
      "risk_keywords": [
        "security",
        "vulnerability",
        "authentication",
        "authorization",
        "breaking change"
      ]
    },
    "approval_methods": ["comment_command", "reaction", "label"],
    "approvers": ["@owner", "@admin"],
    "auto_approve_bots": ["prettier-bot", "dependabot"]
  },
  
  "exclude_paths": [
    "**/*.lock",
    "vendor/**",
    "node_modules/**"
  ]
}
```

---

## 📊 Monitoring & Reports

### View Pending Approvals

```bash
# Command line
bun run agent approvals

# API endpoint
curl http://localhost:3000/approvals
```

### Approval Report

```markdown
# PR Autopilot Approval Report

Generated: 2024-01-15 10:30 AM

## Summary
- Pending: 3
- Approved: 15
- Rejected: 2

## Pending Approvals
| ID | Repo | PR | File | Reason | Created |
|---|---|---|---|---|---|
| approval-my-repo-123... | my/repo | 123 | src/db.ts:45 | risky_file | 2024-01-15 9:00 AM |
```

### Logs

Check logs for approval activity:

```
[APPROVAL] Added pending approval: approval-my-repo-123-abc456
[APPROVAL] Approved approval-my-repo-123-abc456 by reviewer
[APPROVAL] Posted approved comment to my/repo#123
```

---

## 🔐 Security Best Practices

1. **Require approval for sensitive files**
   - Database configs
   - Auth modules
   - Environment files
   - Secret management

2. **Set appropriate risk level**
   - `low`: Auto-apply most fixes
   - `medium`: Require approval for risky changes
   - `high`: Require approval for all changes

3. **Limit approvers**
   - Only trusted team members
   - Repository admins
   - Code owners

4. **Audit trail**
   - All approvals are logged
   - Reports available on demand
   - Old approvals auto-cleaned

---

## 🧪 Testing

### Test Approval Flow

1. Create a PR with a change to a sensitive file
2. Watch for approval request comment
3. Approve with command: `/pr-autopilot approve <id>`
4. Verify patch is applied

### Test Qwen Mode

```bash
# Run with verbose logging
DEBUG=true bun run agent process owner/repo 123

# Look for Qwen-specific logs
[QWEN-FULL-MODE] Starting full-file Qwen session
[THINKING] Analyzing code structure...
```

---

## 📋 Quick Reference

| Command | Description |
|---------|-------------|
| `/pr-autopilot approve <id>` | Approve a pending patch |
| `/pr-autopilot reject <id> [reason]` | Reject a pending patch |
| `/pr-autopilot approvals` | List pending approvals |
| `/pr-autopilot approval <id>` | View approval details |
| `/pr-autopilot report` | Generate approval report |

---

## 🆘 Troubleshooting

### Qwen Mode Not Working

1. Check configuration file exists
2. Verify `use_qwen_full_file: true`
3. Check logs for `[QWEN-FULL-MODE]` messages
4. Ensure Qwen CLI is installed: `qwen --version`

### Approval Not Working

1. Verify user has approval permissions
2. Check approval ID is correct
3. Review logs: `[APPROVAL]` messages
4. Ensure octokit has proper permissions

### Patches Stuck in Pending

1. List pending: `/pr-autopilot approvals`
2. Manually approve or reject
3. Check agent is running and processing queue
4. Review state machine logs

---

For more details, see [IMPROVEMENTS.md](./IMPROVEMENTS.md) and [QUICKSTART.md](./QUICKSTART.md).
