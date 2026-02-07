import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
export class PatchGenerator {
    tempDir;
    constructor() {
        this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-autopilot-'));
    }
    /**
     * Generate a patch for a comment
     * Level 1: Mechanical (suggested changes, formatting)
     * Level 2: Context-aware (LLM-assisted)
     * Level 3: Ask-before-apply
     */
    async generatePatch(request, level = 2) {
        console.log(`[PATCH] ====== Generating patch for ${request.file} ======`);
        console.log(`[PATCH] Level: ${level}`);
        console.log(`[PATCH] Lines: ${request.start_line}-${request.end_line}`);
        console.log(`[PATCH] Content preview: ${request.content?.substring(0, 150).replace(/\n/g, '\\n')}...`);
        console.log(`[PATCH] Has diff_hunk: ${!!request.diff_hunk}`);
        try {
            // Level 1: Mechanical - extract GitHub suggestion blocks
            if (level === 1) {
                console.log(`[PATCH] Trying mechanical extraction (Level 1)`);
                const mechanicalPatch = await this.extractGitHubSuggestion(request);
                if (mechanicalPatch) {
                    console.log(`[PATCH] Mechanical extraction succeeded!`);
                    console.log(`[PATCH] Patch preview:\n${mechanicalPatch.substring(0, 300)}...`);
                    // Validate the patch
                    const isValid = await this.validatePatch(request.repo, request.commit_sha, mechanicalPatch, request.file);
                    if (isValid) {
                        console.log(`[PATCH] Patch validation passed`);
                        return {
                            success: true,
                            patch: mechanicalPatch,
                            requires_approval: false,
                        };
                    }
                    else {
                        console.log(`[PATCH] Mechanical patch invalid, falling back to LLM`);
                    }
                }
                else {
                    console.log(`[PATCH] No GitHub suggestion block found`);
                }
            }
            // Level 2 & 3: LLM-assisted
            console.log(`[PATCH] Using LLM-assisted generation (Level ${level})`);
            const llmPatch = await this.generateLLMPatch(request, level);
            return {
                success: llmPatch.success,
                patch: llmPatch.patch,
                error: llmPatch.error,
                requires_approval: level === 3,
            };
        }
        catch (error) {
            console.error(`[PATCH] Unexpected error:`, error.message);
            return {
                success: false,
                error: error.message,
                requires_approval: true,
            };
        }
    }
    /**
     * Extract GitHub suggestion block from comment content
     * GitHub format: ```suggestion\n...new code...\n```
     */
    async extractGitHubSuggestion(request) {
        console.log(`[PATCH] extractGitHubSuggestion called`);
        const { content, file, start_line, end_line } = request;
        // Look for ```suggestion ... ``` blocks
        const suggestionRegex = /```suggestion\n([\s\S]*?)\n```/;
        const match = content.match(suggestionRegex);
        if (!match) {
            console.log(`[PATCH] No \`\`\`suggestion block found in content`);
            return null;
        }
        const newCode = match[1];
        console.log(`[PATCH] Found suggestion block with ${newCode.split('\n').length} lines`);
        console.log(`[PATCH] Suggested code:\n${newCode.substring(0, 200)}...`);
        // Fetch the file content to build a proper unified diff
        console.log(`[PATCH] Fetching file content to build unified diff...`);
        const fileContent = await this.fetchFileWithContext(request);
        if (!fileContent) {
            console.log(`[PATCH] Could not fetch file content, cannot create patch`);
            return null;
        }
        // Build a proper unified diff with context
        return this.createUnifiedDiffFromCode(file, start_line, end_line, fileContent, newCode);
    }
    /**
     * Build a unified diff patch from GitHub's diff_hunk and suggestion
     */
    buildPatchFromDiffHunk(diffHunk, filePath, newCode, startLine, endLine) {
        console.log(`[PATCH] buildPatchFromDiffHunk called`);
        console.log(`[PATCH] Original diff_hunk:\n${diffHunk.substring(0, 200)}...`);
        // Parse the diff hunk header to get context
        const headerMatch = diffHunk.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (!headerMatch) {
            console.log(`[PATCH] Could not parse diff_hunk header`);
            return null;
        }
        const oldStart = parseInt(headerMatch[1], 10);
        const oldCount = parseInt(headerMatch[2] || '1', 10);
        const newStart = parseInt(headerMatch[3], 10);
        const newCount = parseInt(headerMatch[4] || '1', 10);
        console.log(`[PATCH] Parsed header: -${oldStart},${oldCount} +${newStart},${newCount}`);
        // Build a proper unified diff
        const newLines = newCode.split('\n');
        const newLineCount = newLines.length;
        // Calculate the context lines (3 lines before and after is standard)
        const contextStart = Math.max(1, oldStart - 3);
        const contextLinesBefore = oldStart - contextStart;
        // For a simple replacement, the patch format is:
        // @@ -oldStart,oldCount +newStart,newLineCount @@
        let patch = `--- a/${filePath}\n`;
        patch += `+++ b/${filePath}\n`;
        // The hunk header: @@ -start,count +start,count @@
        // For replacing lines start_line to end_line with new content:
        const linesToReplace = endLine - startLine + 1;
        patch += `@@ -${startLine},${linesToReplace} +${startLine},${newLineCount} @@\n`;
        // Add context lines before (marked with space)
        // We need to fetch these from the actual file
        console.log(`[PATCH] Need to fetch ${contextLinesBefore} context lines before`);
        // For now, just build the minimal patch
        // The lines being replaced (marked with -)
        // Since we don't have the original content, we'll use the suggestion format
        // which git apply can handle if we use --3way or if the context matches
        // Actually, let's use a different approach - use git's built-in diff format
        // by creating old and new files and using git diff
        return this.buildUnifiedDiff(filePath, startLine, endLine, newCode);
    }
    /**
     * Build a proper unified diff by comparing old and new content
     */
    buildUnifiedDiff(filePath, startLine, endLine, newCode) {
        console.log(`[PATCH] buildUnifiedDiff called for ${filePath} lines ${startLine}-${endLine}`);
        // This is a placeholder - the actual implementation would need to:
        // 1. Fetch the original file content
        // 2. Extract the lines being replaced
        // 3. Build a proper unified diff
        // For GitHub suggestions, we can use a simpler approach
        // Create a patch that git apply can understand
        const newLines = newCode.split('\n');
        const numNewLines = newLines.length;
        const numOldLines = endLine - startLine + 1;
        // Build minimal unified diff
        let patch = `--- a/${filePath}\n`;
        patch += `+++ b/${filePath}\n`;
        // Hunk header format: @@ -start,count +start,count @@
        patch += `@@ -${startLine},${numOldLines} +${startLine},${numNewLines} @@\n`;
        // Since we don't have original content, add marker that this needs the original
        // This is a limitation - we need the original lines to create a valid patch
        console.log(`[PATCH] Generated patch header: @@ -${startLine},${numOldLines} +${startLine},${numNewLines} @@`);
        console.log(`[PATCH] WARNING: Patch missing original context lines`);
        return patch + newLines.map(l => '+' + l).join('\n') + '\n';
    }
    /**
     * Generate patch using LLM (Level 2 & 3)
     */
    async generateLLMPatch(request, level) {
        console.log(`[PATCH] generateLLMPatch called for level ${level}`);
        // Fetch the file content with context
        console.log(`[PATCH] Fetching file content from repo...`);
        const fileContent = await this.fetchFileWithContext(request);
        if (!fileContent) {
            console.log(`[PATCH] ERROR: Could not fetch file: ${request.file}`);
            return {
                success: false,
                error: `Could not fetch file: ${request.file}`,
                requires_approval: true,
            };
        }
        console.log(`[PATCH] File fetched successfully, ${fileContent.lines.length} total lines`);
        console.log(`[PATCH] Context extracted: lines ${fileContent.line_offset + 1} to ${fileContent.line_offset + fileContent.lines.length}`);
        // Build the prompt for LLM
        const prompt = this.buildLLMPrompt(request, fileContent, level);
        console.log(`[PATCH] LLM prompt built (${prompt.length} chars)`);
        // Call Zo Ask API
        console.log(`[PATCH] Calling LLM API...`);
        const llmResponse = await this.callLLM(prompt);
        if (!llmResponse.success) {
            console.log(`[PATCH] LLM call failed: ${llmResponse.error}`);
            return {
                success: false,
                error: llmResponse.error || 'LLM generation failed',
                requires_approval: true,
            };
        }
        if (!llmResponse.output) {
            console.log(`[PATCH] LLM returned no output`);
            return {
                success: false,
                error: 'LLM did not return any output',
                requires_approval: true,
            };
        }
        console.log(`[PATCH] LLM returned ${llmResponse.output.length} chars`);
        console.log(`[PATCH] LLM output preview:\n${llmResponse.output.substring(0, 400)}...`);
        // Extract and validate the patch
        let patch = this.extractPatchFromResponse(llmResponse.output);
        if (!patch) {
            console.log(`[PATCH] Could not extract valid patch from LLM response`);
            console.log(`[PATCH] Attempting to create patch from code block...`);
            // Try to create a patch from a code block
            const codeBlock = this.extractCodeBlock(llmResponse.output);
            if (codeBlock) {
                console.log(`[PATCH] Found code block, building unified diff`);
                const originalLines = fileContent.lines.slice(request.start_line - 1, request.end_line);
                const normalized = this.restoreBaselineIndent(codeBlock, originalLines);
                patch = this.createUnifiedDiffFromCode(request.file, request.start_line, request.end_line, fileContent, normalized);
            }
        }
        if (!patch) {
            return {
                success: false,
                error: 'Could not generate valid patch from LLM output',
                requires_approval: true,
            };
        }
        console.log(`[PATCH] Extracted patch:\n${patch.substring(0, 400)}...`);
        // Validate the patch
        console.log(`[PATCH] Validating patch...`);
        const isValid = await this.validatePatch(request.repo, request.commit_sha, patch, request.file);
        if (!isValid) {
            console.log(`[PATCH] Patch validation failed`);
            return {
                success: false,
                error: 'Generated patch does not apply cleanly',
                requires_approval: true,
            };
        }
        console.log(`[PATCH] Patch generation successful!`);
        return {
            success: true,
            patch: patch,
            requires_approval: level === 3,
        };
    }
    /**
     * Fetch file content with surrounding context
     */
    async fetchFileWithContext(request) {
        const { repo, commit_sha, file, start_line, end_line } = request;
        console.log(`[PATCH] fetchFileWithContext: ${file} at ${commit_sha || 'HEAD'}`);
        try {
            const [owner, repoName] = repo.split('/');
            // Clone repo shallowly
            const repoDir = path.join(this.tempDir, `${owner}-${repoName}`);
            if (!fs.existsSync(repoDir)) {
                console.log(`[PATCH] Cloning repo ${repo}...`);
                execSync(`git clone --depth=1 https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${repo}.git ${repoDir}`, { cwd: this.tempDir, stdio: 'ignore', timeout: 60000 });
                console.log(`[PATCH] Clone complete`);
            }
            else {
                console.log(`[PATCH] Using existing clone at ${repoDir}`);
            }
            // Checkout the specific commit
            if (commit_sha) {
                console.log(`[PATCH] Fetching commit ${commit_sha}...`);
                try {
                    execSync(`git fetch --depth=1 origin ${commit_sha}`, { cwd: repoDir, stdio: 'ignore' });
                    execSync(`git checkout ${commit_sha}`, { cwd: repoDir, stdio: 'ignore' });
                    console.log(`[PATCH] Checked out ${commit_sha}`);
                }
                catch (e) {
                    console.log(`[PATCH] Could not checkout ${commit_sha}, using HEAD`);
                    execSync(`git checkout HEAD`, { cwd: repoDir, stdio: 'ignore' });
                }
            }
            // Read the file
            const filePath = path.join(repoDir, file);
            if (!fs.existsSync(filePath)) {
                console.log(`[PATCH] ERROR: File not found: ${filePath}`);
                return null;
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            console.log(`[PATCH] File read: ${lines.length} lines`);
            // Extract context (10 lines before and after)
            const contextStart = Math.max(0, start_line - 11);
            const contextEnd = Math.min(lines.length, end_line + 10);
            const contextLines = lines.slice(contextStart, contextEnd);
            console.log(`[PATCH] Context: lines ${contextStart + 1} to ${contextEnd} (${contextLines.length} lines)`);
            return {
                full_content: content,
                lines: lines,
                context: contextLines.join('\n'),
                line_offset: contextStart,
            };
        }
        catch (error) {
            console.error(`[PATCH] Error fetching file:`, error.message);
            return null;
        }
    }
    /**
     * Create unified diff from extracted code and original file context
     */
    createUnifiedDiffFromCode(filePath, startLine, endLine, fileData, newCode) {
        console.log(`[PATCH] createUnifiedDiffFromCode: ${filePath} lines ${startLine}-${endLine}`);
        const lines = fileData.lines;
        const newLines = newCode.split('\n');
        // Context lines (standard unified diff uses 3 lines of context)
        const contextLines = 3;
        // Calculate the actual start of the hunk (including context before)
        const hunkStartLine = Math.max(1, startLine - contextLines);
        // Calculate how many context lines we actually have before
        const contextBeforeCount = startLine - hunkStartLine;
        // Calculate context after
        const contextAfterStart = endLine;
        const contextAfterCount = Math.min(contextLines, lines.length - contextAfterStart);
        // Old file: context before + removed lines + context after
        const oldCount = contextBeforeCount + (endLine - startLine + 1) + contextAfterCount;
        // New file: context before + added lines + context after
        const newCount = contextBeforeCount + newLines.length + contextAfterCount;
        console.log(`[PATCH] Diff header: -${hunkStartLine},${oldCount} +${hunkStartLine},${newCount}`);
        // Build the patch
        let patch = `--- a/${filePath}\n`;
        patch += `+++ b/${filePath}\n`;
        patch += `@@ -${hunkStartLine},${oldCount} +${hunkStartLine},${newCount} @@\n`;
        // Context before
        for (let i = hunkStartLine - 1; i < startLine - 1 && i < lines.length; i++) {
            patch += ' ' + lines[i] + '\n';
        }
        // Removed lines
        for (let i = startLine - 1; i <= endLine - 1 && i < lines.length; i++) {
            patch += '-' + lines[i] + '\n';
        }
        // Added lines
        for (const line of newLines) {
            patch += '+' + line + '\n';
        }
        // Context after
        for (let i = contextAfterStart; i < contextAfterStart + contextAfterCount && i < lines.length; i++) {
            patch += ' ' + lines[i] + '\n';
        }
        console.log(`[PATCH] Generated patch:\n${patch.substring(0, 600)}...`);
        return patch;
    }
    /**
     * Extract code block from LLM response
     */
    extractCodeBlock(response) {
        // Try various code block formats
        // Format 1: ```lang\ncode\n```
        const match1 = response.match(/```(?:\w+)?\n([\s\S]*?)\n```/);
        if (match1) {
            const code = match1[1].replace(/\r\n/g, '\n').trimEnd();
            console.log(`[PATCH] Extracted code block (${code.length} chars)`);
            return code;
        }
        // Format 2: ```code```
        const match2 = response.match(/```([\s\S]*?)```/);
        if (match2) {
            const code = match2[1].replace(/\r\n/g, '\n').trimEnd();
            console.log(`[PATCH] Extracted code block (${code.length} chars)`);
            return code;
        }
        return null;
    }
    restoreBaselineIndent(newCode, originalLines) {
        const leadingWs = (s) => (s.match(/^[\t ]*/)?.[0] ?? '');
        const origFirstNonEmpty = originalLines.find(l => l.trim().length > 0);
        if (!origFirstNonEmpty)
            return newCode;
        const origIndent = leadingWs(origFirstNonEmpty);
        if (!origIndent)
            return newCode;
        const lines = newCode.split('\n');
        const firstIdx = lines.findIndex(l => l.trim().length > 0);
        if (firstIdx === -1)
            return newCode;
        const firstIndentLen = leadingWs(lines[firstIdx]).length;
        const origIndentLen = origIndent.length;
        const restNonEmpty = lines
            .map((l, i) => ({ l, i }))
            .filter(x => x.i !== firstIdx && x.l.trim().length > 0);
        const restMinIndentLen = restNonEmpty.length === 0
            ? Number.POSITIVE_INFINITY
            : Math.min(...restNonEmpty.map(x => leadingWs(x.l).length));
        if (firstIndentLen < origIndentLen && restMinIndentLen >= origIndentLen) {
            console.log(`[PATCH] Restoring first-line indent: adding ${origIndentLen - firstIndentLen} chars`);
            lines[firstIdx] = origIndent + lines[firstIdx];
            return lines.join('\n');
        }
        const allNonEmptyIndents = lines
            .filter(l => l.trim().length > 0)
            .map(l => leadingWs(l).length);
        const newMinIndentLen = Math.min(...allNonEmptyIndents);
        if (newMinIndentLen < origIndentLen) {
            const pad = origIndent.slice(0, origIndentLen - newMinIndentLen);
            console.log(`[PATCH] Restoring block indent: shifting ${pad.length} chars right`);
            return lines.map(l => (l.trim().length ? pad + l : l)).join('\n');
        }
        return newCode;
    }
    /**
     * Build prompt for LLM
     */
    buildLLMPrompt(request, fileData, level) {
        const { file, start_line, end_line, content, diff_hunk } = request;
        // Get the actual lines being modified
        const originalLines = fileData.lines.slice(start_line - 1, end_line);
        let prompt = `You are a code review assistant. Generate a unified diff patch to fix a code review comment.

FILE: ${file}
LINES TO MODIFY: ${start_line}-${end_line}

ORIGINAL CODE (lines ${start_line}-${end_line}):
${'```'}
${originalLines.join('\n')}
${'```'}

REVIEW COMMENT:
${'"""'}
${content}
${'"""'}

${diff_hunk ? `GITHUB DIFF CONTEXT:\n${'```'}\n${diff_hunk}\n${'```'}\n` : ''}

YOUR TASK:
1. Generate the fixed code that addresses the review comment
2. Return ONLY the complete fixed code block (the new version of lines ${start_line}-${end_line})
3. Do NOT include explanations, markdown formatting instructions, or diff syntax
4. Preserve indentation and code style

Return the fixed code in a code block like this:
${'```'}
// your fixed code here
${'```'}
`;
        if (level === 3) {
            prompt += `\nNOTE: This is a high-risk change. Be extra careful with the fix.\n`;
        }
        return prompt;
    }
    sleep(ms) {
        return new Promise(res => setTimeout(res, ms));
    }
    /**
      * Call Gemini API for LLM generation with retry on rate limits
      */
    async callLLM(prompt) {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.log(`[PATCH] ERROR: GEMINI_API_KEY not set`);
            return {
                success: false,
                error: 'GEMINI_API_KEY not configured',
            };
        }
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
        const maxAttempts = 5;
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                console.log(`[PATCH] POST ${url.split('?')[0]} (${prompt.length} chars)${attempt > 1 ? ` [attempt ${attempt}/${maxAttempts}]` : ''}`);
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                    }),
                });
                console.log(`[PATCH] LLM response status: ${response.status}`);
                if (response.ok) {
                    const result = await response.json();
                    const output = result.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (!output) {
                        console.log(`[PATCH] No text in Gemini response`);
                        return { success: false, error: 'No text content in Gemini response' };
                    }
                    return { success: true, output };
                }
                const status = response.status;
                const retryable = status === 429 || status === 500 || status === 503;
                const errorText = await response.text();
                lastError = `LLM API error: ${status} - ${errorText}`;
                if (!retryable || attempt === maxAttempts) {
                    console.log(`[PATCH] LLM error (non-retryable or final attempt): ${lastError}`);
                    return { success: false, error: lastError };
                }
                const retryAfter = response.headers.get('retry-after');
                const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : NaN;
                const backoff = Math.min(30000, 500 * 2 ** (attempt - 1));
                const jitter = Math.floor(Math.random() * 250);
                const waitMs = Number.isFinite(retryAfterMs) ? retryAfterMs : backoff + jitter;
                console.log(`[PATCH] Gemini retryable error (${status}); attempt ${attempt}/${maxAttempts}, waiting ${waitMs}ms`);
                await this.sleep(waitMs);
            }
            catch (error) {
                lastError = error.message;
                if (attempt === maxAttempts) {
                    console.error(`[PATCH] LLM request failed after ${maxAttempts} attempts:`, lastError);
                    return { success: false, error: lastError };
                }
                const backoff = Math.min(30000, 500 * 2 ** (attempt - 1));
                const jitter = Math.floor(Math.random() * 250);
                console.log(`[PATCH] LLM request error, retrying in ${backoff + jitter}ms: ${lastError}`);
                await this.sleep(backoff + jitter);
            }
        }
        return { success: false, error: lastError ?? 'Unknown LLM error' };
    }
    /**
     * Extract patch from LLM response
     */
    extractPatchFromResponse(response) {
        console.log(`[PATCH] extractPatchFromResponse called`);
        // Look for unified diff format with proper headers
        const diffRegex = /(--- a\/[^\n]+\n\+\+\+ b\/[^\n]+(?:\n@@[^\n]+@@(?:\n[\-+ ].*)*)+)/s;
        const diffMatch = response.match(diffRegex);
        if (diffMatch) {
            console.log(`[PATCH] Found unified diff format`);
            return diffMatch[1].trim();
        }
        // Try to extract diff from code block
        const codeBlockMatch = response.match(/```diff\n([\s\S]*?)\n```/);
        if (codeBlockMatch) {
            console.log(`[PATCH] Found diff in code block`);
            return codeBlockMatch[1].trim();
        }
        console.log(`[PATCH] No valid diff format found in response`);
        return null;
    }
    /**
     * Validate that a patch applies cleanly
     */
    async validatePatch(repo, commitSha, patch, filePath) {
        console.log(`[PATCH] validatePatch called for ${filePath || 'unknown file'}`);
        try {
            const [owner, repoName] = repo.split('/');
            const repoDir = path.join(this.tempDir, `${owner}-${repoName}`);
            if (!fs.existsSync(repoDir)) {
                console.log(`[PATCH] ERROR: Repo not cloned at ${repoDir}`);
                return false;
            }
            // Write patch to temp file
            const patchFile = path.join(this.tempDir, `test-${Date.now()}.patch`);
            fs.writeFileSync(patchFile, patch);
            console.log(`[PATCH] Patch written to ${patchFile}`);
            console.log(`[PATCH] Patch content:\n${patch}`);
            try {
                // Checkout the commit first
                if (commitSha) {
                    execSync(`git checkout ${commitSha}`, { cwd: repoDir, stdio: 'ignore' });
                }
                // Try to apply the patch in check mode
                console.log(`[PATCH] Running: git apply --check ${patchFile}`);
                execSync(`git apply --check "${patchFile}"`, {
                    cwd: repoDir,
                    stdio: 'pipe',
                    timeout: 10000,
                });
                console.log(`[PATCH] Patch validation PASSED`);
                fs.unlinkSync(patchFile);
                return true;
            }
            catch (applyError) {
                const stderr = applyError.stderr?.toString() || applyError.message;
                console.log(`[PATCH] Patch validation FAILED: ${stderr}`);
                // Log the patch that failed
                console.log(`[PATCH] Failed patch content:\n${patch}`);
                fs.unlinkSync(patchFile);
                return false;
            }
        }
        catch (error) {
            console.error(`[PATCH] Error during validation:`, error.message);
            return false;
        }
    }
    /**
     * Clean up temporary files
     */
    cleanup() {
        try {
            if (fs.existsSync(this.tempDir)) {
                fs.rmSync(this.tempDir, { recursive: true, force: true });
            }
        }
        catch (error) {
            console.error('[PATCH] Error cleaning up temp directory:', error);
        }
    }
}
