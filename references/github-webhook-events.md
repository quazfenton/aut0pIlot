# GitHub Webhook Events

PR Autopilot listens to the following events:

1. `pull_request`
   - Actions: `opened`, `reopened`, `synchronize`.
   - Purpose: reset the PR state machine (new commits may unlock previously processed comments).
2. `pull_request_review`
   - Action: `submitted` (includes reviews + inline suggestions).
   - Parse both the review body and any inline comments it includes.
3. `pull_request_review_comment`
   - Action: `created` (GitHub fires this when a reviewer writes or updates an inline comment).
   - Contains file path, line numbers, and diff hunks that the parser translates into a normalized `ParsedReviewComment`.
4. `issue_comment`
   - Recognizes `/stop-autofix` so builders can pause automation on a per-PR basis.
   - Any other issue comments are currently ignored.
5. `check_suite` / `check_run` (optional)
   - Not implemented yet, but the app can reuse these events later to gate repeated fix attempts after CI finishes.
