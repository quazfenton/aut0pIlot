---
name: pr-autopilot
description: A meta-automation agent that sits above GitHub PR reviews and continuously closes the loop between reviewers (humans + AI like CodeRabbit) and code changes. Automatically parses review comments, applies fixes, pushes commits, and re-triggers reviews until clean or blocked.
compatibility: Created for Zo Computer
metadata:
  author: veli.zo.computer
allowed-tools: create_agent grep_search list_app_tools edit_agent run_sequential_cmds read_webpage open_webpage use_webpage view_webpage edit_file read_file tool_docs create_rule y
---
# PR Autopilot Skill

A GitHub App + webhook-driven agent that automates PR review feedback handling.

## What It Does

- **Listens to PR events** via GitHub webhooks
- **Parses review comments** (inline, suggested changes, bot reviews like CodeRabbit)
- **Applies fixes** at three automation levels:
  - Level 1: Mechanical auto-apply (suggested changes, formatting, lint fixes)
  - Level 2: Context-aware fixes (LLM-assisted for complex comments)
  - Level 3: Human-in-loop (ask-before-apply for risky changes)
- **Pushes commits to branch** (which currently can automatically re-trigger further comments of diffs (or, sometimes, closure of outdated suggestions)  from the external automated review bots within the same pull request.
- **Repeats until clean** or blocked/max iterations reached
- **Works across many repos** from one central service

## Quick Start

### 1. Set up GitHub App

```bash
cd Skills/pr-autopilot
bun run scripts/setup-github-app.ts
```

This will:

- Guide you through creating a GitHub App
- Set up webhook URL
- Configure required permissions
- Generate and save credentials

### 2. Install the Agent Service

```bash
cd Skills/pr-autopilot
bun install
bun run build
bun run start
```

The agent will:

- Start webhook receiver on port 3000
- Connect to GitHub App
- Begin processing PR events from connected repos

### 3. Configure Repos

Add `file .pr-agent.yml` to any repo:

```yaml
autofix:
  enabled: true
  max_iterations: 5
  allowed_bots:
    - coderabbit
  risk_level: medium  # low, medium, high
  branch_strategy: update_same_pr  # or: helper_pr
```

## Architecture

```markdown
GitHub (PR events)
    ↓ (webhooks)
Central PR Handler Service
    ├─ Webhook receiver
    ├─ Review parser
    ├─ Patch generator
    ├─ Git operations
    └─ State machine
    ↓           ↓
LLM Analysis  GitHub API
```

## Core Components

### Scripts

- `file setup-github-app.ts` - Interactive GitHub App creation
- `file agent.ts` - Main agent service (webhook receiver + processing)
- `file review-parser.ts` - Parse review comments into canonical format
- `file patch-generator.ts` - Generate patches (mechanical + LLM-assisted)
- `file git-ops.ts` - Git operations (clone, branch, commit, push)
- `file state-machine.ts` - PR lifecycle state management
- `file config-loader.ts` - Load repo configuration from `file .pr-agent.yml`
- `file queue.ts` - Job queue for PR processing

### Configuration

- `assets/pr-agent.yml.example` - Example repo configuration
- `file assets/permissions.json` - Required GitHub App permissions

### References

- `file references/github-webhook-events.md` - Webhook event reference
- `file references/llm-prompts.md` - Prompts for patch generation
- `file references/safety-rules.md` - Safety guardrails

## Usage Examples

### View Agent Status

```bash
cd Skills/pr-autopilot
bun run scripts/agent.ts status
```

### Process a PR Manually

```bash
cd Skills/pr-autopilot
bun run scripts/agent.ts process org/repo 123
```

### Stop Auto-fix for a PR

Add a comment on the PR: `/stop-autofix`

### Enable Auto-apply for a Specific Comment

Comment: `/apply` (in reply to a review comment)

## Automation Levels

### Level 1 - Mechanical (100% auto-apply)

- GitHub "suggested change" blocks
- Formatting issues
- Simple lint fixes

### Level 2 - Context-Aware (LLM-assisted)

- Complex logic simplification
- Edge case handling
- Non-trivial refactor suggestions

### Level 3 - Human-in-Loop (ask-before-apply)

- Security changes
- Architecture modifications
- Public API changes

## State Machine

```markdown
NEW → REVIEWED → FIXING → PUSHED → RECHECKING
       ↑                    ↓
    BLOCKED ← NEEDS_HUMAN ← FAILED
```

## Required Environment Variables

- `GITHUB_APP_ID` - GitHub App ID
- `GITHUB_PRIVATE_KEY` - GitHub App private key (PEM)
- `ZO_CLIENT_IDENTITY_TOKEN` - For LLM patch generation
- `REDIS_URL` - Optional: Redis for queue (default: in-memory)
- `WEBHOOK_SECRET` - GitHub webhook secret (optional but recommended)
- `AGENT_PORT` - Port for webhook receiver (default: 3000)

## Safety Features

- Never auto-merges
- Never rewrites history
- Diff-checks before committing
- Basic validation before applying patches
- `/stop-autofix` command to halt
- Max iterations limit
- Full logging of all operations and diffs

## Development

```bash
cd Skills/pr-autopilot
bun install
bun run build  # or bun run dev for watch mode
bun run start
```

Run tests:

```bash
bun test
```