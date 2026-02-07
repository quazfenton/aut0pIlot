# Safety and Guardrails

1. **Never auto-merge.** The agent applies fixes only to the PR branch and leaves merge decisions to humans.
2. **Max iterations.** Configurable in `.pr-agent.yml` (default 5). Once the limit is hit, the state machine transitions to `BLOCKED` and human eyes are required.
3. **Risk-level awareness.** `risk_level` controls which comments can run through automation. Keywords like "security," "database schema," or "breaking change" bump the review to Level 3, which only generates a patch and flags it for manual approval.
4. **/stop-autofix command.** Any issue comment that starts with `/stop-autofix` halts further automation and notifies the contributors.
5. **Log everything.** The queue logs every job, retry, and failure; GitOps logs diffs when available; each applied patch posts a follow-up comment on the PR.
6. **Dry-run validation.** Generated patches are vetted with `git apply --check` before being staged. Invalid patches surface as comments rather than code changes.
