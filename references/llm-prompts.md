# LLM Patch Generation Prompts

PR Autopilot uses Zo’s `zo/ask` API to turn review comments into unified diff patches. The prompt structure is:

1. **Context** – file path, line range, and a code snippet (10 lines before and after the focus area) so the model understands surrounding logic.
2. **Review comment** – the reviewer’s guidance verbatim, including suggested change blocks.
3. **Instructions** – emphasize returning *only* the patch, no extra text, and a clean unified diff format.
4. **Risk level notes** – if the automation tier is 3, append a reminder that the change is high-risk and must be inspected manually.

### Example prompt excerpt
```
You are helping fix a code review comment on a pull request.

File: src/app/api.ts
Lines 120-129

Review comment:
"""
We should bail early when `req.user` is missing instead of falling back to undefined.
"""

Current code (with 8 lines of context):
"""
const user = req.body.user ?? fetchUser();
if (!user) {
  throw new Error('Missing user');
}
...
"""
```

The model is asked to output a patch like:
```
--- a/src/app/api.ts
+++ b/src/app/api.ts
@@ -121,7 +121,9 @@
-const user = req.body.user ?? fetchUser();
-if (!user) {
-  throw new Error('Missing user');
-}
+const user = req.body.user;
+if (!user) {
+  throw new Error('Missing user');
+}
```
