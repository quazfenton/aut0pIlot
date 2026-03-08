# PR Autopilot 🤖

> **Automated PR review comment processing with AI-powered patch generation and approval workflows**

PR Autopilot automatically processes GitHub PR review comments from AI bots (CodeRabbit, Cubic Dev AI, etc.) and generates committable patches using LLMs (Gemini, Mistral, Qwen).

---

## 📋 Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Modes & Settings](#modes--settings)
- [Lifecycle Management](#lifecycle-management)
- [Approval System](#approval-system)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)

---

## ✨ Features

### Core Features
- 🔄 **Automated Webhook Processing** - Receives GitHub webhooks for PR review comments
- 🤖 **Multi-Bot Support** - Works with CodeRabbit, Cubic Dev AI, Greptile, Sourcery, and more
- 🧠 **AI-Powered Patch Generation** - Uses Gemini, Mistral, or Qwen to generate fixes
- ✅ **Smart Approval System** - Automatic detection of risky changes requiring human approval
- 🔀 **Branch Strategies** - Support for direct commits or isolated helper branches
- 📊 **Persistent State** - Crash recovery and pending work tracking
- 🎯 **Iterative Retry Logic** - Multiple attempts with error learning
- 📝 **Enhanced Logging** - Thinking capture, visual diff highlighting, session reports

### Advanced Features
- **Qwen Full-File Mode** - Full-file editing with broader context awareness
- **Visual Error Analysis** - Side-by-side diff highlighting for failed patches
- **Batch Processing** - Queue-based webhook processing with concurrency control
- **Agent Lifecycle Management** - Auto start/stop based on queue state
- **GitHub App Authentication** - Support for both PAT and GitHub App auth
- **Format After Fix** - Auto-run prettier/eslint after applying patches
- **Workflow Integration** - Run tests/lint after applying fixes

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
bun install
```

### 2. Configure Environment

```bash
cp env_example .env
# Edit .env with your credentials
```

**Required Variables:**
```bash
# GitHub Authentication
GITHUB_TOKEN=ghp_your_personal_access_token

# Webhook Security
WEBHOOK_SECRET=your_random_secret_here

# LLM APIs (at least one)
GEMINI_API_KEY=your_gemini_key
MISTRAL_API_KEY=your_mistral_key
```

### 3. Create Configuration

Create `.pr-autopilot.config.json`:

```json
{
  "autofix": {
    "enabled": true,
    "branch_strategy": "helper_pr",
    "risk_level": "medium",
    "allowed_bots": ["coderabbitai", "cubic-dev-ai"],
    "use_qwen_full_file": true,
    "max_qwen_rounds": 5
  }
}
```

### 4. Start Agent

```bash
bun run scripts/agent.ts
```

### 5. Test Health

```bash
curl http://localhost:3000/health
```

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      GitHub Webhooks                         │
│  (PR Review Comments from AI Bots)                          │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                   n8n Webhook Handler                        │
│  (Receives, validates, queues webhooks)                     │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                   Queue Processor                            │
│  (Manages webhook queue, starts agent if needed)            │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                    PR Autopilot Agent                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Webhook Handler  │  Comment Tracker  │  State Machine│   │
│  ├──────────────────────────────────────────────────────┤   │
│  │  Patch Generator  │  Approval Manager │  Git Ops      │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────────────┬────────────────────────────────────────┘
                     │
         ┌───────────┼───────────┐
         │           │           │
         ▼           ▼           ▼
    ┌────────┐  ┌────────┐  ┌────────┐
    │ Gemini │  │Mistral │  │ Qwen   │
    │  API   │  │  API   │  │  CLI   │
    └────────┘  └────────┘  └────────┘
```

### Key Components

| Component | File | Description |
|-----------|------|-------------|
| **Agent** | `scripts/agent.ts` | Main server, webhook handlers, job processor |
| **Patch Generator** | `scripts/patch-generator.ts` | Traditional LLM-based patch generation |
| **Iterative Generator** | `scripts/iterative-patch-generator.ts` | Multi-round retry logic |
| **Qwen Session** | `scripts/qwen-full-file-session.ts` | Full-file Qwen CLI integration |
| **Approval Manager** | `scripts/approval-manager.ts` | Approval workflow handling |
| **Comment Tracker** | `scripts/comment-tracker.ts` | Tracks comment status |
| **State Machine** | `scripts/state-machine.ts` | PR state management |
| **Git Ops** | `scripts/git-ops.ts` | Git operations (clone, commit, push) |
| **Error Analyzer** | `scripts/patch-error-analyzer.ts` | Visual diff highlighting |

---

## ⚙️ Configuration

### Configuration File

Location: `.pr-autopilot.config.json`

### Full Configuration Template

```json
{
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
    "branch_strategy": "helper_pr",
    "require_approval_for_risky": true,
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
        "**/database.*",
        "**/auth.*"
      ],
      "patterns": [".*password.*", ".*api_key.*", ".*secret.*"],
      "risk_keywords": ["security", "authentication", "breaking change"]
    },
    "approval_methods": ["comment_command", "reaction"],
    "approvers": ["@owner", "@admin"],
    "auto_approve_bots": ["prettier-bot", "dependabot"]
  },
  "exclude_paths": ["**/*.lock", "vendor/**", "node_modules/**"],
  "bot_settings": {
    "coderabbitai": {
      "process_all": true,
      "auto_apply_suggestions": true
    }
  }
}
```

---

## 🎯 Modes & Settings

### Branch Strategy

| Option | Description | Use Case |
|--------|-------------|----------|
| `"helper_pr"` | Creates `autopilot/pr-{N}-fixes` branch | **Recommended** - Isolated fixes, safer |
| `"update_same_pr"` | Commits directly to PR branch | Simple workflows, trusted fixes |

### Risk Level

| Level | Behavior |
|-------|----------|
| `"low"` | Auto-apply most fixes, minimal approval |
| `"medium"` | Require approval for risky changes (recommended) |
| `"high"` | Require approval for all changes |

### Qwen Modes

| Setting | Description | Recommended |
|---------|-------------|-------------|
| `use_cli_tools` | Use CLI tools for better diffs | `true` |
| `use_iterative_generator` | Enable retry logic with error learning | `true` |
| `use_qwen_full_file` | Full-file editing with broader context | `true` |
| `max_qwen_rounds` | Number of retry attempts | `5` |
| `qwen_timeout_ms` | Timeout per round (ms) | `180000` (3 min) |

### Approval Triggers

Patches automatically require approval when they:

1. **Match file patterns**: `.env*`, `*secret*`, `*credential*`, `*database*`, `*auth*`
2. **Contain patterns**: `password`, `api_key`, `secret`, `token`
3. **Include keywords**: `security`, `authentication`, `breaking change`
4. **Are flagged by risk level**: Based on `risk_level` setting

---

## 🔄 Lifecycle Management

### Agent Lifecycle

The agent can be managed in two ways:

#### 1. Manual Management

```bash
# Start
bun run scripts/agent.ts

# Stop
Ctrl+C or kill <pid>

# Check status
curl http://localhost:3000/health
```

#### 2. Automatic Lifecycle Management

Use the lifecycle manager for auto start/stop:

```bash
# Start lifecycle manager
node n8n-integration/agent-lifecycle-manager.js &
```

**Configuration:**
```bash
AGENT_PORT=3000
QUEUE_DIR=/tmp/pr-autopilot-queue
IDLE_TIMEOUT_MS=60000      # Stop after 1 min idle
HEALTH_CHECK_INTERVAL_MS=5000
AGENT_START_TIMEOUT_MS=30000
```

**Behavior:**
- Automatically starts agent when queue has items
- Monitors agent health via `/health` endpoint
- Stops agent after idle timeout to save resources
- Prevents multiple instances
- Handles graceful shutdown

### Webhook Lifecycle

```
1. GitHub sends webhook → n8n
2. n8n forwards to queue (/tmp/pr-autopilot-queue)
3. Queue processor picks up webhook
4. If agent not running, starts it (or uses existing)
5. Agent processes webhook, generates patch
6. Patch applied, committed, pushed
7. If queue empty + idle timeout → agent stops
```

### State Persistence

**Locations:**
- Comment tracking: `.pr-autopilot/*.json`
- State machine: `/tmp/pr-autopilot-states/states.json`
- Approvals: `.pr-autopilot/pending-approvals.json`
- Logs: `logs/session-*.jsonl`

**Recovery:**
On startup, agent recovers:
- Pending comments not yet processed
- Failed patches that can be retried
- Pending approvals awaiting review

---

## ✅ Approval System

### Approval Commands

Comment on PR with:

| Command | Description |
|---------|-------------|
| `/pr-autopilot approve <id>` | Approve a pending patch |
| `/pr-autopilot reject <id> [reason]` | Reject a patch |
| `/pr-autopilot approvals` | List pending approvals |
| `/pr-autopilot approval <id>` | View approval details |

### Example Workflow

**1. Bot posts approval request:**
```
⚠️ **Patch Requires Approval**

**File**: `src/config/database.ts:45-67`
**Reason**: risky_file (matches pattern: **/database.*)
**Approval ID**: `approval-my-repo-123-abc456`

**To approve**, comment:
```
/pr-autopilot approve approval-my-repo-123-abc456
```
```

**2. Reviewer approves:**
```
/pr-autopilot approve approval-my-repo-123-abc456
```

**3. Bot confirms:**
```
✅ **Patch Approved**

**File**: `src/config/database.ts:45-67`
**Approved by**: @reviewer

_Patch will be applied in the next processing cycle._
```

### Who Can Approve?

- Repository owners
- Users with admin/maintain/push permissions
- Users listed in `approval_settings.approvers`

---

## 📡 API Reference

### Health & Status

```bash
# Health check
GET /health

# Response:
{
  "status": "ok",
  "queue": {
    "length": 5,
    "processing": 2,
    "jobs": [...]
  }
}
```

### Approval Management

```bash
# List all approvals
GET /approvals?repo=owner/repo&pr=123&status=pending

# List pending only
GET /approvals/pending?repo=owner/repo

# Get approval details
GET /approvals/:id

# Approve via API
POST /approvals/:id/approve
Body: { "user": "username" }

# Reject via API
POST /approvals/:id/reject
Body: { "user": "username", "reason": "security concern" }

# Generate report
GET /approvals/report
```

### Webhooks

```bash
# Receive GitHub webhook
POST /webhook
Headers:
  - X-GitHub-Event
  - X-GitHub-Delivery
  - X-Hub-Signature-256
```

---

## 🐛 Troubleshooting

### Common Issues

#### "No pending comments" in logs

**Problem:** Comments tracked but not processed

**Solution:**
1. Check state machine logs: `[STATE]` messages
2. Verify CommentTracker has comments: `[TRACKER]` messages
3. Check fallback mechanism activates
4. Review `.pr-autopilot/*.json` files

#### Patch generation fails

**Problem:** LLM can't generate valid patch

**Solution:**
1. Enable Qwen full-file mode: `"use_qwen_full_file": true`
2. Increase rounds: `"max_qwen_rounds": 5`
3. Check logs for error analysis
4. Review session report: `logs/session-*.md`

#### Approval not working

**Problem:** Commands not recognized

**Solution:**
1. Verify user has approval permissions
2. Check approval ID matches exactly
3. Review `[APPROVAL]` logs
4. Ensure octokit has `repo` scope

#### Agent won't start

**Problem:** Port in use or config error

**Solution:**
```bash
# Check port
lsof -i :3000

# Kill existing
pkill -f "bun.*agent"

# Check config
cat .pr-autopilot.config.json

# Start with debug
DEBUG=true bun run scripts/agent.ts
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

# All logs (JSONL)
cat logs/session-*.jsonl | jq .
```

---

## 📚 Additional Documentation

- [SETUP_COMPLETE.md](./SETUP_COMPLETE.md) - Complete setup guide
- [CONFIG_AND_APPROVAL.md](./CONFIG_AND_APPROVAL.md) - Configuration reference
- [IMPROVEMENTS.md](./IMPROVEMENTS.md) - Technical improvements
- [QUICKSTART.md](./QUICKSTART.md) - Getting started

---

## 🧪 Testing

```bash
# Run all tests
bun test

# Unit tests
bun run test:unit

# Advanced diff tests
node run-advanced-diff-tests.js
```

---

## 📊 Monitoring

### Queue Status

```bash
bun run agent status
```

### Health Endpoint

```bash
curl http://localhost:3000/health
```

### Approval Report

```bash
curl http://localhost:3000/approvals/report
```

---

## 🔐 Security

- Webhook signature verification
- Approval permission checking
- Audit trail for all approvals
- Secure credential storage via environment variables
- Token redaction in logs

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `bun test`
5. Submit a pull request

---

## 📄 License

MIT

---

## 🆘 Support

For issues or questions:
1. Check troubleshooting section
2. Review logs in `logs/`
3. Enable debug mode: `DEBUG=true`
4. Open an issue with session report attached

---

**Made with ❤️ for automated code review**
