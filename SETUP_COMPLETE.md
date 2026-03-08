# PR Autopilot - Complete Setup & Usage Guide

## 🚀 Quick Start

### 1. Enable Qwen Iterative Mode (Full Qwen Mode)

Create `.pr-autopilot.config.json` in your repository root:

```json
{
  "autofix": {
    "enabled": true,
    "use_cli_tools": true,
    "use_iterative_generator": true,
    "use_qwen_full_file": true,
    "max_qwen_rounds": 5,
    "qwen_timeout_ms": 180000,
    "risk_level": "medium",
    "allowed_bots": ["coderabbitai", "cubic-dev-ai", "codeant-ai"],
    "branch_strategy": "update_same_pr",
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
        "**/database.*",
        "**/auth.*"
      ],
      "patterns": [".*password.*", ".*api_key.*", ".*secret.*"],
      "risk_keywords": ["security", "authentication", "breaking change"]
    },
    "approvers": ["@owner", "@admin"],
    "approval_methods": ["comment_command", "reaction"]
  }
}
```

### 2. Restart Agent

```bash
# Stop existing agent
pkill -f "bun.*agent"

# Start with new config
bun run scripts/agent.ts
```

### 3. Verify Qwen Mode is Active

Watch for these log messages:
```
[ITERATIVE-PATCH] ══ Starting iterative patch generation for file.ts ══
[STEP] Max rounds: 5, Max LLM retries: 3
[QWEN-FULL-MODE] Starting full-file Qwen session
```

---

## ✅ Patch Approval System

### How It Works

1. **Automatic Detection**: Patches requiring approval are automatically detected based on:
   - File patterns (`.env*`, `*secret*`, `*credential*`, `*database*`)
   - Content patterns (`password`, `api_key`, `secret`)
   - Risk keywords (`security`, `authentication`, `breaking change`)
   - Risk level setting

2. **Approval Request Posted**: When a patch needs approval, a comment is posted:
   ```
   ⚠️ **Patch Requires Approval**
   
   **File**: `src/config/database.ts:45-67`
   **Reason**: risky_file (matches pattern: **/database.*)
   **Approval ID**: `approval-my_repo-123-abc456`
   
   **To approve**, comment:
   ```
   /pr-autopilot approve approval-my_repo-123-abc456
   ```
   
   **To reject**, comment:
   ```
   /pr-autopilot reject approval-my_repo-123-abc456 [your reason]
   ```
   ```

3. **Review & Approve**: Authorized users approve or reject via commands

4. **Processing**: Approved patches are automatically applied

### Approval Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/pr-autopilot approve <id>` | Approve a pending patch | `/pr-autopilot approve approval-repo-123-abc` |
| `/pr-autopilot reject <id> [reason]` | Reject a patch | `/pr-autopilot reject approval-repo-123-abc security concern` |
| `/pr-autopilot approvals` | List all pending approvals | `/pr-autopilot approvals` |
| `/pr-autopilot approval <id>` | View approval details | `/pr-autopilot approval approval-repo-123-abc` |
| `/pr-autopilot pending` | Alias for approvals | `/pr-autopilot pending` |

### Who Can Approve?

By default, these users can approve:
- Repository owners
- Users with admin/maintain/push permissions
- Users listed in `approval_settings.approvers`

### Example Workflow

#### Step 1: Bot Posts Approval Request

```
⚠️ **Patch Requires Approval**

**File**: `src/database/config.ts:45-67`
**Reason**: risky_file (matches pattern: **/database.*)
**Approval ID**: `approval-my_repo-9-db456`

---

**To approve**, comment:
```
/pr-autopilot approve approval-my_repo-9-db456
```

**To reject**, comment:
```
/pr-autopilot reject approval-my_repo-9-db456 [reason]
```

---

<details>
<summary>📄 View Patch</summary>

```diff
--- a/src/database/config.ts
+++ b/src/database/config.ts
@@ -45,6 +45,7 @@ export class Database {
   async connect() {
-    this.connection = await mongoose.connect(process.env.MONGODB_URI);
+    this.connection = await mongoose.connect(process.env.MONGODB_URI, {
+      ssl: true
+    });
   }
 }
```

</details>
```

#### Step 2: Reviewer Approves

```
/pr-autopilot approve approval-my_repo-9-db456
```

#### Step 3: Bot Confirms & Applies

```
✅ **Patch Approved**

**File**: `src/database/config.ts:45-67`
**Approved by**: @reviewer
**Time**: 2024-01-15 10:30 AM

_Patch will be applied in the next processing cycle._
```

---

## 🔧 Configuration Options

### Full Configuration Template

```json
{
  "$schema": "https://json.schemastore.org/pr-autopilot.config.json",
  "autofix": {
    "enabled": true,
    "max_iterations": 5,
    "risk_level": "medium",
    "allowed_bots": [
      "coderabbitai",
      "cubic-dev-ai",
      "coderabbit",
      "greptileapps",
      "graphiteapp",
      "sourcery-ai",
      "qodocodereview",
      "codeant-ai"
    ],
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
        "**/auth.*",
        "**/security.*"
      ],
      "patterns": [
        ".*password.*",
        ".*api_key.*",
        ".*secret.*",
        ".*token.*"
      ],
      "risk_keywords": [
        "security",
        "vulnerability",
        "authentication",
        "authorization",
        "breaking change",
        "database schema",
        "migration"
      ]
    },
    "approval_methods": [
      "comment_command",
      "reaction",
      "label"
    ],
    "approvers": [
      "@owner",
      "@admin",
      "@specific-user"
    ],
    "auto_approve_bots": [
      "prettier-bot",
      "dependabot"
    ]
  },
  
  "workflows": {
    "enabled": false,
    "steps": []
  },
  
  "exclude_paths": [
    "**/*.lock",
    "vendor/**",
    "node_modules/**",
    "**/*.min.js",
    "**/*.min.css"
  ],
  
  "bot_settings": {
    "coderabbitai": {
      "process_all": true,
      "auto_apply_suggestions": true
    },
    "cubic-dev-ai": {
      "process_all": true,
      "auto_apply_suggestions": true
    },
    "codeant-ai": {
      "process_all": true,
      "auto_apply_suggestions": true
    }
  }
}
```

### Configuration Descriptions

#### Autofix Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable auto-fixes |
| `max_iterations` | number | `5` | Max fix iterations per PR |
| `risk_level` | string | `"medium"` | `low`, `medium`, or `high` |
| `allowed_bots` | array | `[]` | Bot names to auto-apply |
| `branch_strategy` | string | `"update_same_pr"` | `update_same_pr` or `helper_pr` |
| `use_cli_tools` | boolean | `false` | Use CLI tools for better patches |
| `use_iterative_generator` | boolean | `false` | Enable iterative retry logic |
| `use_qwen_full_file` | boolean | `false` | Enable full Qwen mode |
| `max_qwen_rounds` | number | `5` | Max Qwen retry rounds |
| `qwen_timeout_ms` | number | `180000` | Timeout per Qwen round (3 min) |
| `format_after_fix` | boolean | `false` | Run formatter after fixes |

#### Approval Settings

| Option | Type | Description |
|--------|------|-------------|
| `require_approval_for.files` | array | File patterns requiring approval |
| `require_approval_for.patterns` | array | Content patterns requiring approval |
| `require_approval_for.risk_keywords` | array | Keywords requiring approval |
| `approvers` | array | Users who can approve |
| `approval_methods` | array | Allowed approval methods |
| `auto_approve_bots` | array | Bots auto-approved |

---

## 📊 Monitoring & Reports

### View Pending Approvals

**Via Comment Command:**
```
/pr-autopilot approvals
```

**Via API:**
```bash
# List all pending
curl http://localhost:3000/approvals/pending

# Filter by repo
curl "http://localhost:3000/approvals/pending?repo=owner/repo"

# Filter by PR
curl "http://localhost:3000/approvals/pending?repo=owner/repo&pr=123"
```

**Response:**
```json
{
  "count": 2,
  "pending": [
    {
      "id": "approval-repo-123-abc",
      "repo": "owner/repo",
      "pr": 123,
      "file": "src/db.ts",
      "startLine": 45,
      "endLine": 67,
      "reason": "risky_file",
      "status": "pending",
      "createdAt": "2024-01-15T09:00:00Z"
    }
  ]
}
```

### Approval Report

**Via API:**
```bash
curl http://localhost:3000/approvals/report
```

**Output:**
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

---

## 🔐 Security Best Practices

### 1. Require Approval for Sensitive Files

```json
{
  "approval_settings": {
    "require_approval_for": {
      "files": [
        "**/*.env*",
        "**/*secret*",
        "**/*credential*",
        "**/config/production.*",
        "**/database.*",
        "**/auth.*",
        "**/security.*"
      ]
    }
  }
}
```

### 2. Set Appropriate Risk Level

- **`low`**: Auto-apply most fixes (trusted repos only)
- **`medium`**: Require approval for risky changes (recommended)
- **`high`**: Require approval for all changes (production repos)

### 3. Limit Approvers

```json
{
  "approval_settings": {
    "approvers": [
      "@owner",
      "@admin",
      "@tech-lead"
    ]
  }
}
```

### 4. Audit Trail

All approvals are:
- Logged with timestamps
- Associated with user accounts
- Stored in `.pr-autopilot/pending-approvals.json`
- Included in session reports

---

## 🧪 Testing

### Test Qwen Mode

```bash
# Run with verbose logging
DEBUG=true bun run agent process owner/repo 123

# Look for Qwen-specific logs
[QWEN-FULL-MODE] Starting full-file Qwen session
[THINKING] Analyzing code structure...
```

### Test Approval Flow

1. **Create a PR** with a change to a sensitive file (e.g., `database.config.ts`)

2. **Watch for approval request** comment

3. **Approve with command**:
   ```
   /pr-autopilot approve approval-id-here
   ```

4. **Verify patch is applied** in next processing cycle

### Test Permission Denial

1. Have a non-authorized user try to approve:
   ```
   /pr-autopilot approve approval-id-here
   ```

2. Bot should respond with permission denied message

---

## 📋 Quick Reference

### Enable Qwen Mode

```json
{
  "autofix": {
    "use_qwen_full_file": true,
    "max_qwen_rounds": 5
  }
}
```

### Approval Commands

```
/pr-autopilot approve <id>          # Approve patch
/pr-autopilot reject <id> [reason]  # Reject patch
/pr-autopilot approvals             # List pending
/pr-autopilot approval <id>         # View details
```

### API Endpoints

```
GET  /approvals              # List all approvals
GET  /approvals/pending      # List pending only
GET  /approvals/:id          # Get approval details
POST /approvals/:id/approve  # Approve via API
POST /approvals/:id/reject   # Reject via API
GET  /approvals/report       # Generate report
```

### Log Patterns

```
[APPROVAL] Added pending approval: approval-id
[APPROVAL] Approved approval-id by user
[QWEN-FULL-MODE] Starting full-file Qwen session
[ITERATIVE-PATCH] Starting iterative patch generation
```

---

## 🆘 Troubleshooting

### Qwen Mode Not Working

1. **Check config file exists**: `ls -la .pr-autopilot.config.json`
2. **Verify settings**: `"use_qwen_full_file": true`
3. **Check logs**: Look for `[QWEN-FULL-MODE]` messages
4. **Ensure Qwen CLI installed**: `qwen --version`

### Approval Not Working

1. **Verify user permissions**: User must be owner/admin/collaborator
2. **Check approval ID**: Must match exactly
3. **Review logs**: Look for `[APPROVAL]` messages
4. **Check octokit permissions**: Token needs `repo` scope

### Patches Stuck in Pending

1. **List pending**: `/pr-autopilot approvals`
2. **Manually approve/reject**
3. **Check agent is running**: `curl localhost:3000/health`
4. **Review state machine logs**: `[STATE]` messages

### Permission Denied

User needs one of:
- Repository owner
- Admin permission
- Maintain permission
- Push permission
- Listed in `approval_settings.approvers`

---

## 📚 Additional Resources

- [IMPROVEMENTS.md](./IMPROVEMENTS.md) - Full technical documentation
- [QUICKSTART.md](./QUICKSTART.md) - Getting started guide
- [CONFIG_AND_APPROVAL.md](./CONFIG_AND_APPROVAL.md) - Configuration reference

---

## ✅ Setup Checklist

- [ ] Create `.pr-autopilot.config.json`
- [ ] Set `use_qwen_full_file: true`
- [ ] Configure approval requirements
- [ ] Set risk level appropriately
- [ ] List authorized approvers
- [ ] Restart agent
- [ ] Test with a PR
- [ ] Verify approval commands work
- [ ] Check logs for Qwen activity

Congratulations! You now have full Qwen iterative mode enabled with a complete approval workflow! 🎉
