Automation of PR Review comment reviews, edits, and commits

Integration with the feedback of common pull request code review agents such as @coderabbitai and @cubic-dev-ai

Receives webhooks of repo events to automate the completiob of tasks such as updating code, replies under PR threads noting fixes and comments resolved for errors action was taken in response to, and creating branches to do so.

Integration with custom CLI tools and LLM commands.

Robust Patch Repair: Updated repairIncompletePatch and unescapePatchContent in ./scripts/patch-generator.ts to handle a wider variety of malformed LLM outputs. It now correctly manages mixed indentation, trailing spaces, and missing space prefixes in context lines, which were primary causes of "corrupt patch" errors.
Advanced Unescaping: Expanded the unescaping logic to handle more cases (tabs, carriage returns, escaped quotes, brackets, and braces) that often appear in LLM-generated diffs within markdown blocks.
Dynamic Default Branch Detection: Enhanced ./scripts/git-ops.ts with a getDefaultBranch method that queries the remote (remote show origin) to reliably identify the base branch (e.g., main, master, features) instead of relying on a hardcoded list.
Full Project Scope for LLM tools such as Qwen: Refined callQwenWithProjectContext to ensure a dedicated clone of the repository is always available for the Qwen CLI, providing the model with full project context (including file structure and related file contents).
Iterative Discovery Mode: Improved the iterative Qwen workflow to include a "discovery" phase that identifies if a requested fix requires broader changes across multiple files, providing these findings as context for subsequent refinement iterations.



Multi-Hunk Patch Repair:

Updated repairIncompletePatch in ./scripts/patch-generator.ts to iterate through all hunks in a file.
It now recalculates line counts for each hunk independently and ensures context lines always have the required space prefix.
Enhanced Unescaping & Normalization:

Refined unescapePatchContent to handle common LLM artifacts like single-@ hunk headers, escaped \+ or \- symbols, and missing prefixes on empty context lines.
Added a fix for broken hunk headers containing regex artifacts (e.g., $3,$4).
Dynamic Branch Detection:

Implemented getDefaultBranch in ./scripts/git-ops.ts which queries the remote (remote show origin) to find the true default branch, improving reliability during rebases and helper branch creation.
Improved Discovery & Diagnostics:

Enhanced the Qwen discovery phase to better identify cross-file dependencies by providing more project structure context.
Added --verbose logging to git apply --check failures to capture and display detailed stdout/stderr for easier debugging of validation errors.

Workflow Support:

Added workflows configuration to ./scripts/types.ts.
Implemented runCommand in ./scripts/git-ops.ts to execute arbitrary commands (tests, linting) within the repository.
handleProcessJob in ./scripts/agent.ts now executes these workflow steps after applying patches and before committing.
Mass Committing & Batching:

Redesigned ./scripts/agent.ts to group multiple review comments into a single "batch job" per PR.
Updated ./scripts/state-machine.ts to track pending_comments for each PR.
handleProcessJob now generates patches for all pending comments, applies them in bulk, and creates a single descriptive commit for the entire batch.
Extended Event Triggers:

Added webhook handlers for check_run and workflow_run in ./scripts/agent.ts to provide better integration with CI/CD status.
Robustness Improvements:

Added logic to roll back or notify users if workflow steps fail.
Ensured comments that require manual approval or fail patch generation are correctly marked to prevent processing loops.

implemented advanced workflow features, including environment variables, timeouts, and custom working directories, and enabled manual command execution via PR comments. I've also enhanced handleProcessJob to provide detailed reports on these workflow results.
Execution Isolation: Updated ./scripts/types.ts to support env, timeout_ms, and working_dir for each workflow step.
Enhanced Execution Engine: Upgraded runCommand in ./scripts/git-ops.ts to handle custom environment variables, directory contexts, and execution timeouts.
Detailed Reporting: handleProcessJob in ./scripts/agent.ts now provides a comprehensive summary of workflow results (test passes/fails) in the PR comments.
🛠️ On-Demand Commands
Manual Triggers: Added support for manual command execution via PR comments using the syntax /autopilot run <command>.
High Priority Processing: Manual commands are enqueued with elevated priority for immediate feedback.
Branch Awareness: Commands automatically run against the current state of the PR (or the active helper branch if one exists).
🤖 Reporting & Transparency
Improved error reporting with detailed diffs and truncated logs for failed workflow steps.
Success comments now explicitly list all fixed files and the status of each workflow step (e.g., ✅ Tests, ✅ Lint).