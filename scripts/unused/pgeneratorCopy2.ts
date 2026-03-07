import { PatchRequest, PatchResult } from './types';
import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const log = {
  header:  (msg: string) => console.log(`\n\x1b[1;36m[PATCH] ══ ${msg} ══\x1b[0m`),
  step:    (msg: string) => console.log(`\x1b[32m[PATCH]\x1b[0m ${msg}`),
  detail:  (msg: string) => console.log(`\x1b[2m[PATCH] ${msg}\x1b[0m`),
  warn:    (msg: string) => console.log(`\x1b[33m[PATCH]\x1b[0m ${msg}`),
  error:   (msg: string) => console.log(`\x1b[31m[PATCH]\x1b[0m ${msg}`),
  llmError:(msg: string) => console.log(`\x1b[35m[PATCH]\x1b[0m ${msg}`),
  success: (msg: string) => console.log(`\x1b[1;32m[PATCH] ✓\x1b[0m ${msg}`),
};

interface FileSnapshot {
  full_content: string;
  lines: string[];
  context: string;
  line_offset: number;
}

export class PatchGenerator {
  private tempDir: string;

  constructor() {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-autopilot-'));
  }

  /**
   * Generate a patch for a comment
   * Level 1: Mechanical (suggested changes, formatting)
   * Level 2: Context-aware (LLM-assisted)
   * Level 3: Ask-before-apply
   */
  async generatePatch(
    request: PatchRequest,
    level: number = 2
  ): Promise<PatchResult> {
    log.header(`Generating patch for ${request.file}`);
    log.step(`Level: ${level}`);
    log.step(`Lines: ${request.start_line}-${request.end_line}`);
    log.detail(`Content preview: ${request.content?.substring(0, 150).replace(/\n/g, '\\n')}...`);
    log.detail(`Has diff_hunk: ${!!request.diff_hunk}`);

    try {
      // Always try mechanical extraction first (suggestions from any level)
      const hasSuggestions = request.suggestions && request.suggestions.length > 0;
      const hasContentSuggestion = /```suggestion\b/i.test(request.content);

      if (hasSuggestions || hasContentSuggestion) {
        log.step(`Trying mechanical extraction (suggestions found)`);
        const mechanicalPatch = await this.extractGitHubSuggestion(request);
        if (mechanicalPatch) {
          log.success(`Mechanical extraction succeeded!`);
          log.detail(`Patch preview:\n${mechanicalPatch.substring(0, 300)}...`);
          
          const isValid = await this.validatePatch(request.repo, request.commit_sha, mechanicalPatch, request.file);
          if (isValid) {
            log.success(`Patch validation passed`);
            return {
              success: true,
              patch: mechanicalPatch,
              requires_approval: level === 3,
            };
          } else {
            log.warn(`Mechanical patch invalid, falling back to LLM`);
          }
        } else {
          log.step(`No extractable suggestion block found`);
        }
      }

      // LLM-assisted generation (with proposed fixes / agent prompt as context)
      log.step(`Using LLM-assisted generation (Level ${level})`);
      const llmPatch = await this.generateLLMPatch(request, level);
      
      return {
        success: llmPatch.success,
        patch: llmPatch.patch,
        error: llmPatch.error,
        requires_approval: level === 3,
      };
    } catch (error: any) {
      log.error(`Unexpected error: ${error.message}`);
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
  private async extractGitHubSuggestion(request: PatchRequest): Promise<string | null> {
    log.step(`extractGitHubSuggestion called`);
    
    const { content, file, start_line, end_line } = request;
    
    // Try pre-extracted suggestions first (from review-parser structured extraction)
    let newCode: string | null = null;

    if (request.suggestions && request.suggestions.length > 0) {
      newCode = request.suggestions[0].code;
      log.detail(`Using pre-extracted suggestion (${request.suggestions[0].source}/${request.suggestions[0].section}): ${newCode.length} chars`);
    }

    // Fallback: look for ```suggestion blocks in raw content
    if (!newCode) {
      const suggestionRegex = /```suggestion\b[^\n]*\n([\s\S]*?)```/;
      const match = content.match(suggestionRegex);
      if (match) {
        newCode = match[1].replace(/\r\n/g, '\n').trimEnd();
        log.detail(`Found suggestion block in content: ${newCode.length} chars`);
      }
    }
    
    if (!newCode) {
      log.step(`No suggestion block found`);
      return null;
    }

    log.detail(`Suggestion code (${newCode.split('\n').length} lines):\n${newCode.substring(0, 200)}...`);

    log.step(`Fetching file content to build unified diff...`);
    const fileContent = await this.fetchFileWithContext(request);
    
    if (!fileContent) {
      log.error(`Could not fetch file content, cannot create patch`);
      return null;
    }

    return this.createUnifiedDiffFromCode(file, start_line, end_line, fileContent, newCode);
  }

  /**
   * Build a unified diff patch from GitHub's diff_hunk and suggestion
   */
  private buildPatchFromDiffHunk(
    diffHunk: string,
    filePath: string,
    newCode: string,
    startLine: number,
    endLine: number
  ): string | null {
    log.step(`buildPatchFromDiffHunk called`);
    log.detail(`Original diff_hunk:\n${diffHunk.substring(0, 200)}...`);

    // Parse the diff hunk header to get context
    const headerMatch = diffHunk.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!headerMatch) {
      log.error(`Could not parse diff_hunk header`);
      return null;
    }

    const oldStart = parseInt(headerMatch[1], 10);
    const oldCount = parseInt(headerMatch[2] || '1', 10);
    const newStart = parseInt(headerMatch[3], 10);
    const newCount = parseInt(headerMatch[4] || '1', 10);

    log.detail(`Parsed header: -${oldStart},${oldCount} +${newStart},${newCount}`);

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
    log.detail(`Need to fetch ${contextLinesBefore} context lines before`);

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
  private buildUnifiedDiff(
    filePath: string,
    startLine: number,
    endLine: number,
    newCode: string
  ): string | null {
    log.step(`buildUnifiedDiff called for ${filePath} lines ${startLine}-${endLine}`);
    
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
    
    log.detail(`Generated patch header: @@ -${startLine},${numOldLines} +${startLine},${numNewLines} @@`);
    log.warn(`Patch missing original context lines`);
    
    return patch + newLines.map(l => '+' + l).join('\n') + '\n';
  }

  /**
   * Generate patch using LLM (Level 2 & 3)
   */
  private async generateLLMPatch(
    request: PatchRequest,
    level: number
  ): Promise<PatchResult> {
    log.step(`generateLLMPatch called for level ${level}`);
    
    // Fetch the file content with context
    log.step(`Fetching file content from repo...`);
    const fileContent = await this.fetchFileWithContext(request);
    
    if (!fileContent) {
      log.error(`Could not fetch file: ${request.file}`);
      return {
        success: false,
        error: `Could not fetch file: ${request.file}`,
        requires_approval: true,
      };
    }

    log.step(`File fetched successfully, ${fileContent.lines.length} total lines`);
    log.detail(`Context extracted: lines ${fileContent.line_offset + 1} to ${fileContent.line_offset + fileContent.lines.length}`);

    const reviewerCodeBlock = this.extractCodeBlock(request.content || '');
    if (reviewerCodeBlock) {
      log.detail(`Reviewer code block detected (${reviewerCodeBlock.length} chars)`);
    }

    // Build the prompt for LLM
    const prompt = this.buildLLMPrompt(request, fileContent, level, reviewerCodeBlock);
    const qwenPrompt = this.buildQwenPrompt(request, fileContent, level, reviewerCodeBlock);
    log.detail(`LLM prompt built (${prompt.length} chars)`);

    let effectiveStartLine = request.start_line;
    let effectiveEndLine = request.end_line;
    if (request.start_line === request.end_line) {
      effectiveStartLine = Math.max(1, request.start_line - 20);
      effectiveEndLine = Math.min(fileContent.lines.length, request.end_line + 5);
    }

    // Call Zo Ask API
    log.step(`Calling LLM API...`);
    const llmResponse = await this.callLLM(prompt, qwenPrompt);

    if (!llmResponse.success) {
      log.error(`LLM call failed: ${llmResponse.error}`);
      return {
        success: false,
        error: llmResponse.error || 'LLM generation failed',
        requires_approval: true,
      };
    }

    if (!llmResponse.output) {
      log.error(`LLM returned no output`);
      return {
        success: false,
        error: 'LLM did not return any output',
        requires_approval: true,
      };
    }

    log.detail(`LLM returned ${llmResponse.output.length} chars`);
    log.detail(`LLM output preview:\n${llmResponse.output.substring(0, 400)}...`);

    // Extract and validate the patch
    let patch = this.extractPatchFromResponse(llmResponse.output, request.file);

    if (!patch) {
      log.warn(`Could not extract valid patch from LLM response`);
      log.step(`Attempting to create patch from code block...`);
      
      // Try to create a patch from a code block
      const codeBlock = this.extractCodeBlock(llmResponse.output);
      if (codeBlock) {
        log.step(`Found code block, building unified diff`);
        const originalLines = fileContent.lines.slice(effectiveStartLine - 1, effectiveEndLine);
        const normalized = this.restoreBaselineIndent(codeBlock, originalLines);
        patch = this.createUnifiedDiffFromCode(request.file, effectiveStartLine, effectiveEndLine, fileContent, normalized);
      }
    }

    if (!patch) {
      return {
        success: false,
        error: 'Could not generate valid patch from LLM output',
        requires_approval: true,
      };
    }

    log.detail(`Extracted patch:\n${patch.substring(0, 400)}...`);

    // Validate the patch
    log.step(`Validating patch...`);
    const isValid = await this.validatePatch(request.repo, request.commit_sha, patch, request.file);
    
    if (!isValid) {
      log.error(`Patch validation failed`);
      return {
        success: false,
        error: 'Generated patch does not apply cleanly',
        requires_approval: true,
      };
    }

    const qwenCheck = await this.qwenPostValidateIfEnabled(request, fileContent, patch);
    if (!qwenCheck.ok) {
      log.warn(`Qwen post-validate flagged potential issues`);
      return {
        success: false,
        error: qwenCheck.message || 'Qwen validation flagged potential issues',
        requires_approval: true,
      };
    }

    log.success(`Patch generation successful!`);
    return {
      success: true,
      patch: patch,
      requires_approval: level === 3,
    };
  }

  /**
   * Fetch file content with surrounding context
   */
  private async fetchFileWithContext(request: PatchRequest): Promise<FileSnapshot | null> {
    const { repo, commit_sha, file, start_line, end_line } = request;
    
    log.step(`fetchFileWithContext: ${file} at ${commit_sha || 'HEAD'}`);

    try {
      const [owner, repoName] = repo.split('/');
      
      // Clone repo shallowly
      const repoDir = path.join(this.tempDir, `${owner}-${repoName}`);
      
      if (!fs.existsSync(repoDir)) {
        log.step(`Cloning repo ${repo}...`);
        execSync(
          `git clone --depth=1 https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${repo}.git ${repoDir}`,
          { cwd: this.tempDir, stdio: 'ignore', timeout: 60000 }
        );
        log.step(`Clone complete`);
      } else {
        log.detail(`Using existing clone at ${repoDir}`);
      }

      // Checkout the specific commit
      if (commit_sha) {
        log.step(`Fetching commit ${commit_sha}...`);
        try {
          execSync(`git fetch --depth=1 origin ${commit_sha}`, { cwd: repoDir, stdio: 'ignore' });
          execSync(`git checkout ${commit_sha}`, { cwd: repoDir, stdio: 'ignore' });
          log.step(`Checked out ${commit_sha}`);
        } catch (e) {
          log.warn(`Could not checkout ${commit_sha}, using HEAD`);
          execSync(`git checkout HEAD`, { cwd: repoDir, stdio: 'ignore' });
        }
      }

      // Read the file
      const filePath = path.join(repoDir, file);
      if (!fs.existsSync(filePath)) {
        log.error(`File not found: ${filePath}`);
        return null;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      log.detail(`File read: ${lines.length} lines`);

      // Extract context (10 lines before and after)
      const contextStart = Math.max(0, start_line - 11);
      const contextEnd = Math.min(lines.length, end_line + 10);
      const contextLines = lines.slice(contextStart, contextEnd);

      log.detail(`Context: lines ${contextStart + 1} to ${contextEnd} (${contextLines.length} lines)`);

      return {
        full_content: content,
        lines: lines,
        context: contextLines.join('\n'),
        line_offset: contextStart,
      };
    } catch (error: any) {
      log.error(`Error fetching file: ${error.message}`);
      return null;
    }
  }

  /**
   * Create unified diff from extracted code and original file context
   */
  private createUnifiedDiffFromCode(
    filePath: string,
    startLine: number,
    endLine: number,
    fileData: FileSnapshot,
    newCode: string
  ): string {
    log.step(`createUnifiedDiffFromCode: ${filePath} lines ${startLine}-${endLine}`);
    
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

    log.detail(`Diff header: -${hunkStartLine},${oldCount} +${hunkStartLine},${newCount}`);

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

    const removedLines = patch.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));
    const addedLines = patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    if (removedLines.length === addedLines.length && removedLines.every((l, i) => l.substring(1) === addedLines[i].substring(1))) {
      log.warn(`No-op patch detected (- and + lines identical), skipping`);
      return '';
    }

    log.detail(`Generated patch:\n${patch.substring(0, 600)}...`);
    return patch;
  }

  /**
   * Extract code block from LLM response
   */
  private extractCodeBlock(response: string): string | null {
    // Try various code block formats
    // Format 1: ```lang\ncode\n```
    const match1 = response.match(/```(?:\w+)?\n([\s\S]*?)\n```/);
    if (match1) {
      const code = match1[1].replace(/\r\n/g, '\n').trimEnd();
      log.detail(`Extracted code block (${code.length} chars)`);
      return code;
    }

    // Format 2: ```code```
    const match2 = response.match(/```([\s\S]*?)```/);
    if (match2) {
      const code = match2[1].replace(/\r\n/g, '\n').trimEnd();
      log.detail(`Extracted code block (${code.length} chars)`);
      return code;
    }

    return null;
  }

  private restoreBaselineIndent(newCode: string, originalLines: string[]): string {
    const leadingWs = (s: string) => (s.match(/^[\t ]*/)?.[0] ?? '');

    const origNonEmpty = originalLines.filter(l => l.trim().length > 0);
    if (!origNonEmpty.length) return newCode;

    const origMinIndentLen = Math.min(...origNonEmpty.map(l => leadingWs(l).length));
    if (origMinIndentLen === 0) return newCode;

    const lines = newCode.split('\n');
    const firstIdx = lines.findIndex(l => l.trim().length > 0);
    if (firstIdx === -1) return newCode;

    const firstIndentLen = leadingWs(lines[firstIdx]).length;
    const origIndentLen = origMinIndentLen;

    const restNonEmpty = lines
      .map((l, i) => ({ l, i }))
      .filter(x => x.i !== firstIdx && x.l.trim().length > 0);

    const restMinIndentLen =
      restNonEmpty.length === 0
        ? Number.POSITIVE_INFINITY
        : Math.min(...restNonEmpty.map(x => leadingWs(x.l).length));

    if (firstIndentLen < origIndentLen && restMinIndentLen >= origIndentLen) {
      log.detail(`Restoring first-line indent: adding ${origIndentLen - firstIndentLen} chars`);
      lines[firstIdx] = ' '.repeat(origIndentLen) + lines[firstIdx];
      return lines.join('\n');
    }

    const allNonEmptyIndents = lines
      .filter(l => l.trim().length > 0)
      .map(l => leadingWs(l).length);
    const newMinIndentLen = Math.min(...allNonEmptyIndents);

    if (newMinIndentLen < origIndentLen) {
      const pad = ' '.repeat(origIndentLen - newMinIndentLen);
      log.detail(`Restoring block indent: shifting ${pad.length} chars right`);
      return lines.map(l => (l.trim().length ? pad + l : l)).join('\n');
    }

    return newCode;
  }

  /**
   * Build prompt for LLM
   */
  private buildLLMPrompt(
    request: PatchRequest,
    fileData: FileSnapshot,
    level: number,
    reviewerCodeBlock?: string | null
  ): string {
    const { file, start_line, end_line, content, diff_hunk } = request;

    // For single-line comments, expand scope to allow multi-location fixes (e.g., adding imports)
    let effectiveStartLine = start_line;
    let effectiveEndLine = end_line;
    if (start_line === end_line) {
      effectiveStartLine = Math.max(1, start_line - 20);
      effectiveEndLine = Math.min(fileData.lines.length, end_line + 5);
    }
    const originalLines = fileData.lines.slice(effectiveStartLine - 1, effectiveEndLine);
    
    const hasProposedFix = request.proposed_fixes && request.proposed_fixes.length > 0;
    const hasSuggestions = request.suggestions && request.suggestions.length > 0;
    const hasAgentPrompt = !!request.agent_prompt;

    let prompt = `You are a code review assistant. Fix a code review comment by producing corrected code.

FILE: ${file}
LINES TO MODIFY: ${effectiveStartLine}-${effectiveEndLine}

ORIGINAL CODE (lines ${effectiveStartLine}-${effectiveEndLine}):
${'```'}
${originalLines.join('\n')}
${'```'}

NOTE: If the fix requires changes outside the specified line range (e.g., adding an import statement), include those lines in your response. Return ALL lines from ${effectiveStartLine} to ${effectiveEndLine} with your fixes applied.

${diff_hunk ? `GITHUB DIFF CONTEXT:\n${'```'}\n${diff_hunk}\n${'```'}\n` : ''}`;

    if (hasAgentPrompt) {
      prompt += `\nAI AGENT INSTRUCTIONS (from the reviewer — follow these closely):\n${'"""'}\n${request.agent_prompt}\n${'"""'}\n`;
    }

    if (hasSuggestions) {
      prompt += `\nPRE-EXISTING SUGGESTED CODE (use as starting point — validate and adapt if needed):\n`;
      for (const s of request.suggestions!) {
        prompt += `${'```'}\n${s.code}\n${'```'}\n`;
      }
    }

    if (hasProposedFix) {
      prompt += `\nPROPOSED FIX FROM REVIEWER (use as reference — validate, improve, or adopt):\n`;
      for (const fix of request.proposed_fixes!) {
        prompt += `${'```'}\n${fix}\n${'```'}\n`;
      }
    }

    if (reviewerCodeBlock) {
      prompt += `\nREVIEWER CODE BLOCK (use as reference — validate and adapt if needed):\n${'```'}\n${reviewerCodeBlock}\n${'```'}\n`;
    }

    if (!hasAgentPrompt && !hasProposedFix && !hasSuggestions) {
      prompt += `\nREVIEW COMMENT:\n${'"""'}\n${content}\n${'"""'}\n`;
    } else {
      prompt += `\nREVIEW COMMENT (additional context):\n${'"""'}\n${content}\n${'"""'}\n`;
    }

    if (hasProposedFix || hasSuggestions) {
      prompt += `
YOUR TASK:
1. Use the pre-existing suggested code / proposed fix as a starting point
2. Validate it against the original code — check indentation, scope, imports, and correctness
3. If the suggestion applies cleanly and is correct, return it as-is
4. If it needs adjustment (wrong indentation, missing context, stale lines), fix it
5. Return ONLY a unified diff patch for ${file} with proper headers (--- a/... +++ b/...) and @@ hunk markers
6. Include only the hunks needed for lines ${effectiveStartLine}-${effectiveEndLine} (and related context)
7. Preserve indentation and code style of the original file
`;
    } else {
      prompt += `
YOUR TASK:
1. Generate the fixed code that addresses the review comment
2. Return ONLY a unified diff patch for ${file} with proper headers (--- a/... +++ b/...) and @@ hunk markers
3. Include only the hunks needed for lines ${effectiveStartLine}-${effectiveEndLine} (and related context)
4. Do NOT include explanations or prose
5. Preserve indentation and code style
`;
    }

    prompt += `
Output format requirements:
- Output ONLY the unified diff patch. No prose.
- You may wrap the patch in a \`\`\`diff code block, but do not add any other text.
`;

    if (level === 3) {
      prompt += `\nNOTE: This is a high-risk change. Be extra careful with the fix.\n`;
    }

    return prompt;
  }

  private buildQwenPrompt(
    request: PatchRequest,
    fileData: FileSnapshot,
    level: number,
    reviewerCodeBlock?: string | null
  ): string {
    const { file, start_line, end_line, content, diff_hunk } = request;

    let effectiveStartLine = start_line;
    let effectiveEndLine = end_line;
    if (start_line === end_line) {
      effectiveStartLine = Math.max(1, start_line - 20);
      effectiveEndLine = Math.min(fileData.lines.length, end_line + 5);
    }

    const hasProposedFix = request.proposed_fixes && request.proposed_fixes.length > 0;
    const hasSuggestions = request.suggestions && request.suggestions.length > 0;
    const hasAgentPrompt = !!request.agent_prompt;

    let prompt = `You are a code review assistant. Generate a unified diff patch.

FILE: ${file}
LINES TO MODIFY: ${effectiveStartLine}-${effectiveEndLine}

FULL FILE CONTENT:
${'```'}
${fileData.full_content}
${'```'}

${diff_hunk ? `GITHUB DIFF CONTEXT:\n${'```'}\n${diff_hunk}\n${'```'}\n` : ''}`;

    if (hasAgentPrompt) {
      prompt += `\nAI AGENT INSTRUCTIONS (from the reviewer — follow these closely):\n${'"""'}\n${request.agent_prompt}\n${'"""'}\n`;
    }

    if (hasSuggestions) {
      prompt += `\nPRE-EXISTING SUGGESTED CODE (use as starting point — validate and adapt if needed):\n`;
      for (const s of request.suggestions!) {
        prompt += `${'```'}\n${s.code}\n${'```'}\n`;
      }
    }

    if (hasProposedFix) {
      prompt += `\nPROPOSED FIX FROM REVIEWER (use as reference — validate, improve, or adopt):\n`;
      for (const fix of request.proposed_fixes!) {
        prompt += `${'```'}\n${fix}\n${'```'}\n`;
      }
    }

    if (reviewerCodeBlock) {
      prompt += `\nREVIEWER CODE BLOCK (use as reference — validate and adapt if needed):\n${'```'}\n${reviewerCodeBlock}\n${'```'}\n`;
    }

    prompt += `\nREVIEW COMMENT:\n${'"""'}\n${content}\n${'"""'}\n`;

    prompt += `
YOUR TASK:
1. Generate a unified diff patch for ${file} with proper headers (--- a/... +++ b/...) and @@ hunk markers
2. Include only the hunks needed for lines ${effectiveStartLine}-${effectiveEndLine} (and related context)
3. Do NOT include explanations or prose
4. Preserve indentation and code style
`;

    if (level === 3) {
      prompt += `\nNOTE: This is a high-risk change. Be extra careful with the fix.\n`;
    }

    return prompt;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(res => setTimeout(res, ms));
  }

  private async callGemini(prompt: string): Promise<{ success: boolean; output?: string; error?: string; errorCode?: string; retryable?: boolean; retryAfterMs?: number }> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { success: false, error: 'GEMINI_API_KEY not configured', errorCode: 'NO_KEY' };

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;

    try {
      log.step(`POST Gemini (${prompt.length} chars)`);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });

      log.detail(`Gemini response status: ${response.status}`);

      if (response.ok) {
        const result = await response.json();
        const output = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!output) return { success: false, error: 'No text content in Gemini response', errorCode: 'NO_OUTPUT' };
        return { success: true, output };
      }

      const status = response.status;
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : undefined;
      const retryable = status === 429 || status === 500 || status === 503;
      return { success: false, error: `Gemini API error: ${status}`, errorCode: `HTTP_${status}`, retryable, retryAfterMs };
    } catch (error: any) {
      return { success: false, error: `Gemini request failed: ${error.message}`, errorCode: 'NETWORK', retryable: true };
    }
  }

  private async callMistral(prompt: string): Promise<{ success: boolean; output?: string; error?: string; errorCode?: string; retryable?: boolean; retryAfterMs?: number }> {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) return { success: false, error: 'MISTRAL_API_KEY not configured', errorCode: 'NO_KEY' };

    try {
      log.step(`POST Mistral mistral-large-2512 (${prompt.length} chars)`);
      const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'mistral-large-2512',
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      log.detail(`Mistral response status: ${response.status}`);

      if (response.ok) {
        const result = await response.json();
        const output = result.choices?.[0]?.message?.content;
        if (!output) return { success: false, error: 'No text content in Mistral response', errorCode: 'NO_OUTPUT' };
        return { success: true, output };
      }

      const status = response.status;
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : undefined;
      const retryable = status === 429 || status === 500 || status === 503;
      return { success: false, error: `Mistral API error: ${status}`, errorCode: `HTTP_${status}`, retryable, retryAfterMs };
    } catch (error: any) {
      return { success: false, error: `Mistral request failed: ${error.message}`, errorCode: 'NETWORK', retryable: true };
    }
  }

  private async callQwen(prompt: string): Promise<{ success: boolean; output?: string; error?: string; retryable?: boolean }> {
    try {
      log.step(`Calling local qwen CLI (${prompt.length} chars)`);
      
      const output = execFileSync(
        'qwen',
        ['-p', prompt, '--max-session-turns', '1', '-o', 'text'],
        {
          stdio: 'pipe',
          timeout: 120000,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, NO_COLOR: '1' },
        }
      ).toString().trim();
      
      log.detail(`Qwen returned ${output.length} chars`);
      
      if (!output) {
        return { success: false, error: 'Qwen returned empty output' };
      }
      
      return { success: true, output };
    } catch (error: any) {
      return { success: false, error: `Qwen CLI failed: ${error.message}`, retryable: false };
    }
  }

  /**
    * Call LLM with failover: Gemini → Mistral → 2 delayed retries → local qwen CLI
    */
  private async callLLM(prompt: string, qwenPrompt?: string): Promise<{ success: boolean; output?: string; error?: string }> {
    const geminiAvailable = !!process.env.GEMINI_API_KEY;
    const mistralAvailable = !!process.env.MISTRAL_API_KEY;

    if (!geminiAvailable && !mistralAvailable) {
      log.warn(`No API keys configured, using local qwen CLI`);
      return this.callQwen(qwenPrompt ?? prompt);
    }

    // Step 1: Try Gemini first
    let lastError: string | undefined;

    // Step 1: Try Gemini first
    if (geminiAvailable) {
      const result = await this.callGemini(prompt);
      if (result.success) return result;
      lastError = result.error;
      log.llmError(`Gemini failed: ${result.errorCode ?? 'UNKNOWN'}`);
    }

    // Step 2: Failover to Mistral
    if (mistralAvailable) {
      const result = await this.callMistral(prompt);
      if (result.success) return result;
      lastError = result.error;
      log.llmError(`Mistral failed: ${result.errorCode ?? 'UNKNOWN'}`);
    }

    // Step 3: Exponential backoff retries (per provider), honoring Retry-After when present
    const providers: Array<{
      name: string;
      call: () => Promise<{ success: boolean; output?: string; error?: string; errorCode?: string; retryable?: boolean; retryAfterMs?: number }>;
      retryCount: number;
      nextAllowedAt: number;
    }> = [];
    if (geminiAvailable) providers.push({ name: 'Gemini', call: () => this.callGemini(prompt), retryCount: 0, nextAllowedAt: 0 });
    if (mistralAvailable) providers.push({ name: 'Mistral', call: () => this.callMistral(prompt), retryCount: 0, nextAllowedAt: 0 });

    for (let round = 0; round < 2; round++) {
      const ordered = [...providers].sort((a, b) => a.nextAllowedAt - b.nextAllowedAt);
      for (const provider of ordered) {
        const now = Date.now();
        const waitMs = Math.max(0, provider.nextAllowedAt - now);
        if (waitMs > 0) {
          log.warn(`${provider.name} retry backoff: waiting ${waitMs}ms...`);
          await this.sleep(waitMs);
        }

        const result = await provider.call();
        if (result.success) return result;

        lastError = result.error;
        log.llmError(`${provider.name} failed: ${result.errorCode ?? 'UNKNOWN'}`);

        if (result.retryable) {
          const base = 2000;
          const exp = base * Math.pow(2, provider.retryCount);
          provider.retryCount += 1;
          const retryAfter = result.retryAfterMs ?? 0;
          const backoff = Math.max(exp, retryAfter);
          provider.nextAllowedAt = Date.now() + backoff;
        }
      }
    }

    // Step 4: Last resort — local qwen CLI
    log.warn(`All API providers failed, trying local qwen CLI...`);
    const qwenResult = await this.callQwen(qwenPrompt ?? prompt);
    if (qwenResult.success) return qwenResult;
    log.llmError(`Qwen fallback failed`);

    return { success: false, error: lastError ?? 'All LLM attempts failed' };
  }

  private async qwenPostValidateIfEnabled(
    request: PatchRequest,
    fileData: FileSnapshot,
    patch: string
  ): Promise<{ ok: boolean; message?: string; additionalChanges?: Array<{ file?: string; description?: string }> }> {
    if (process.env.QWEN_VALIDATE !== '1') return { ok: true };

    const prompt = `You are validating a patch for potential missing related changes.

FILE: ${request.file}
LINES TO MODIFY: ${request.start_line}-${request.end_line}

FULL FILE CONTENT:
${'```'}
${fileData.full_content}
${'```'}

PATCH:
${'```'}
${patch}
${'```'}

Respond in JSON only:
{"status":"ok"|"needs_followup"|"deny","notes":"short reason","additional_changes":[{"file":"path","description":"what else should change"}]}
If everything is fine, return {"status":"ok"}.
`;

    const result = await this.callQwen(prompt);
    if (!result.success || !result.output) {
      return { ok: true };
    }

    try {
      const jsonStart = result.output.indexOf('{');
      const jsonEnd = result.output.lastIndexOf('}');
      if (jsonStart === -1 || jsonEnd === -1) return { ok: true };
      const parsed = JSON.parse(result.output.slice(jsonStart, jsonEnd + 1));
      const additionalChanges = Array.isArray(parsed.additional_changes)
        ? parsed.additional_changes.map((c: any) => ({ file: c?.file, description: c?.description }))
        : [];

      if (parsed.status === 'deny') {
        return {
          ok: false,
          message: parsed.notes || 'Qwen denied patch',
          additionalChanges,
        };
      }

      if (parsed.status === 'needs_followup' || additionalChanges.length > 0) {
        const details = additionalChanges
          .map((c: any) => `${c.file ? `${c.file}: ` : ''}${c.description || 'additional change needed'}`)
          .join('; ');
        return {
          ok: false,
          message: parsed.notes || (details ? `Qwen suggests additional changes: ${details}` : 'Qwen suggests additional changes'),
          additionalChanges,
        };
      }
    } catch {
      return { ok: true };
    }

    return { ok: true };
  }

  /**
   * Extract patch from LLM response
   */
  private extractPatchFromResponse(response: string, filePath?: string): string | null {
    log.step(`extractPatchFromResponse called`);
    
    // Look for unified diff format with proper headers
    const diffRegex = /(--- a\/[^\n]+\n\+\+\+ b\/[^\n]+(?:\n@@[^\n]+@@(?:\n[\-+ ].*)*)+)/s;
    const diffMatch = response.match(diffRegex);
    
    if (diffMatch) {
      log.step(`Found unified diff format`);
      return diffMatch[1].trim();
    }

    // Try to extract diff from code block
    const codeBlockMatch = response.match(/```(?:diff|patch)\n([\s\S]*?)\n```/);
    if (codeBlockMatch) {
      const patch = codeBlockMatch[1].trim();
      log.step(`Found diff in code block`);
      return this.normalizePatchHeaders(patch, filePath);
    }

    // Try to extract raw hunk without headers
    const hunkOnlyMatch = response.match(/(@@[\s\S]*?$)/m);
    if (hunkOnlyMatch && filePath) {
      log.step(`Found hunk without headers, normalizing`);
      const patch = hunkOnlyMatch[1].trim();
      return this.normalizePatchHeaders(patch, filePath);
    }

    log.warn(`No valid diff format found in response`);
    return null;
  }

  private normalizePatchHeaders(patch: string, filePath?: string): string | null {
    if (!patch) return null;
    const hasHeaders = /^--- a\//m.test(patch) && /^\+\+\+ b\//m.test(patch);
    if (hasHeaders || !filePath) return patch;
    return `--- a/${filePath}\n+++ b/${filePath}\n${patch}`;
  }

  /**
   * Validate that a patch applies cleanly
   */
  private async validatePatch(
    repo: string,
    commitSha: string,
    patch: string,
    filePath?: string
  ): Promise<boolean> {
    log.step(`validatePatch called for ${filePath || 'unknown file'}`);

    if (!patch || !patch.trim()) {
      log.warn(`Empty patch, skipping validation`);
      return false;
    }
    
    try {
      const [owner, repoName] = repo.split('/');
      const repoDir = path.join(this.tempDir, `${owner}-${repoName}`);

      if (!fs.existsSync(repoDir)) {
        log.error(`Repo not cloned at ${repoDir}`);
        return false;
      }

      // Write patch to temp file
      const patchFile = path.join(this.tempDir, `test-${Date.now()}.patch`);
      fs.writeFileSync(patchFile, patch);
      log.detail(`Patch written to ${patchFile}`);
      log.detail(`Patch content:\n${patch}`);

      try {
        // Checkout the commit first
        if (commitSha) {
          execSync(`git checkout ${commitSha}`, { cwd: repoDir, stdio: 'ignore' });
        }

        // Try to apply the patch in check mode
        log.step(`Running: git apply --check ${patchFile}`);
        execSync(`git apply --check "${patchFile}"`, { 
          cwd: repoDir, 
          stdio: 'pipe',
          timeout: 10000,
        });

        log.success(`Patch validation PASSED`);
        fs.unlinkSync(patchFile);
        return true;
      } catch (applyError: any) {
        const stderr = applyError.stderr?.toString() || applyError.message;
        log.error(`Patch validation FAILED: ${stderr}`);
        
        // Log the patch that failed
        log.detail(`Failed patch content:\n${patch}`);
        
        fs.unlinkSync(patchFile);
        return false;
      }
    } catch (error: any) {
      log.error(`Error during validation: ${error.message}`);
      return false;
    }
  }

  /**
   * Clean up temporary files
   */
  cleanup(): void {
    try {
      if (fs.existsSync(this.tempDir)) {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      }
    } catch (error) {
      log.error(`Error cleaning up temp directory: ${error}`);
    }
  }
}
