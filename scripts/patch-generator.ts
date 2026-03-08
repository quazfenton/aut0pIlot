import { PatchRequest, PatchResult } from './types';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IterativePatchGenerator } from './iterative-patch-generator';

function gitExec(args: string, cwd: string, opts: { pipe?: boolean; timeout?: number } = {}): string {
  const result = execSync(`git ${args}`, {
    cwd,
    stdio: opts.pipe ? 'pipe' : 'ignore',
    timeout: opts.timeout ?? 60000,
  });
  return result ? result.toString().trim() : '';
}

const log = {
  header:  (msg: string) => console.log(`\n\x1b[1;38;5;208m[PATCH] ══ ${msg} ══\x1b[0m`),  // Bright orange header
  step:    (msg: string) => console.log(`\x1b[32m[STEP]\x1b[0m ${msg}`),                   // Green for steps
  detail:  (msg: string) => console.log(`\x1b[2m[DETAIL]\x1b[0m ${msg}`),                 // Dim for details
  warn:    (msg: string) => console.log(`\x1b[1;33m[WARN]\x1b[0m ${msg}`),                // Bold yellow for warnings
  error:   (msg: string) => console.log(`\x1b[1;31m[ERROR]\x1b[0m ${msg}`),               // Bold red for errors
  llmError:(msg: string) => console.log(`\x1b[1;35m[LLM-ERR]\x1b[0m ${msg}`),             // Bold magenta for LLM errors
  success: (msg: string) => console.log(`\x1b[1;32m[SUCCESS]\x1b[0m ${msg}`),             // Bold green for success
  code:    (msg: string) => console.log(`\x1b[36m[CODE]\x1b[0m ${msg}`),                  // Cyan for code-related
  diff:    (msg: string) => console.log(`\x1b[38;5;245m[DIFF]\x1b[0m ${msg}`),            // Light gray for diff
  llmCall: (msg: string) => console.log(`\x1b[38;5;201m[LLM-CALL]\x1b[0m ${msg}`),        // Purple for LLM calls
  checkout: (msg: string) => console.log(`\x1b[38;5;46m[CHECKOUT]\x1b[0m ${msg}`),        // Bright green for checkout
};

function fetchAndCheckout(sha: string, repoDir: string): boolean {
  try {
    gitExec(`cat-file -t ${sha}`, repoDir, { pipe: true });
  } catch {
    try {
      gitExec(`fetch origin ${sha}`, repoDir, { timeout: 120000 });
    } catch {
      try {
        gitExec(`fetch --unshallow origin`, repoDir, { timeout: 120000 });
      } catch {
        try {
          gitExec(`fetch origin`, repoDir, { timeout: 120000 });
        } catch { /* exhausted fetch strategies */ }
      }
    }
  }
  try {
    gitExec(`checkout ${sha}`, repoDir);
    return true;
  } catch {
    return false;
  }
}

interface FileSnapshot {
  full_content: string;
  lines: string[];
  context: string;
  line_offset: number;
}

export class PatchGenerator {
  private tempDir: string;
  private iterativeGenerator: IterativePatchGenerator;
  private gitOps: any; // GitOps instance - using 'any' to avoid circular dependency
  // Thread-local flag to prevent recursive fallback into IterativePatchGenerator
  private static inIterativeFallback = false;

  constructor(gitOps?: any) {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-autopilot-'));
    // Use provided GitOps instance or create a new one
    if (gitOps) {
      this.gitOps = gitOps;
    } else {
      const { GitOps } = require('./git-ops');
      this.gitOps = new GitOps(process.env.GITHUB_TOKEN);
    }
    // Initialize iterative generator with the same GitOps instance
    this.iterativeGenerator = new IterativePatchGenerator(this.gitOps);
  }

  /**
   * Generate a patch for a comment
   * Level 1: Mechanical (suggested changes, formatting)
   * Level 2: Context-aware (LLM-assisted)
   * Level 3: Ask-before-apply
   */
  async generatePatch(
    request: PatchRequest,
    level: number = 2,
    useCliTools: boolean = false
  ): Promise<PatchResult> {
    log.header(`Generating patch for ${request.file}`);
    log.step(`Level: ${level}`);
    log.step(`Lines: ${request.start_line}-${request.end_line}`);
    log.detail(`Content preview: ${request.content?.replace(/\n/g, '\\n')}`);
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
          log.detail(`Patch preview:\n${mechanicalPatch}`);
          
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
      const llmPatch = await this.generateLLMPatch(request, level, useCliTools);
      
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

    log.detail(`Suggestion code (${newCode.split('\n').length} lines):\n${newCode}`);

    log.step(`Fetching file content to build unified diff...`);
    const fileContent = await this.fetchFileWithContext(request);
    
    if (!fileContent) {
      log.error(`Could not fetch file content, cannot create patch`);
      return null;
    }

    const resolved = this.resolveTargetRange(request, fileContent);
    return this.createUnifiedDiffFromCode(file, resolved.start, resolved.end, fileContent, newCode);
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
    log.detail(`Original diff_hunk:\n${diffHunk}`);

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
    
    return patch + newLines.map((l: string) => '+' + l).join('\n') + '\n';
  }

  /**
   * Generate patch using LLM (Level 2 & 3)
   */
  private async generateLLMPatch(
    request: PatchRequest,
    level: number,
    useCliTools: boolean = false
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

    // Build the prompt for LLM
    const prompt = this.buildLLMPrompt(request, fileContent, level);
    log.detail(`LLM prompt built (${prompt.length} chars)`);

    const baseRange = this.resolveTargetRange(request, fileContent);
    let effectiveStartLine = baseRange.start;
    let effectiveEndLine = baseRange.end;
    if (request.start_line === request.end_line) {
      effectiveStartLine = Math.max(1, baseRange.start - 20);
      effectiveEndLine = Math.min(fileContent.lines.length, baseRange.end + 5);
    }

    // Call Zo Ask API
    log.step(`Calling LLM API...`);
    const llmResponse = await this.callLLM(prompt, request, fileContent);

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
    log.detail(`LLM output preview:\n${llmResponse.output}`);

    // Extract and validate the patch
    let patch = this.extractPatchFromResponse(llmResponse.output);

    if (!patch) {
      log.warn(`Could not extract valid patch from LLM response`);
      log.step(`Attempting to create patch from code block...`);

      // Try to create a patch from a code block
      const codeBlock = this.extractCodeBlock(llmResponse.output);
      if (codeBlock) {
        log.step(`Found code block, building unified diff`);
        const originalLines = fileContent.lines.slice(Math.max(0, effectiveStartLine - 1), Math.min(fileContent.lines.length, effectiveEndLine));
        const normalized = this.restoreBaselineIndent(codeBlock, originalLines);
        
        if (useCliTools) {
          // Construct full new content for CLI diffing
          const beforeLines = fileContent.lines.slice(0, effectiveStartLine - 1);
          const afterLines = fileContent.lines.slice(effectiveEndLine);
          const newFullContent = [...beforeLines, normalized, ...afterLines].join('\n');
          
          patch = await this.generateDiffWithCli(request.file, fileContent.full_content, newFullContent);
          if (!patch) {
            log.warn(`CLI diff failed, falling back to internal generator`);
            patch = this.createUnifiedDiffFromCode(request.file, effectiveStartLine, effectiveEndLine, fileContent, normalized);
          }
        } else {
          patch = this.createUnifiedDiffFromCode(request.file, effectiveStartLine, effectiveEndLine, fileContent, normalized);
        }
      }
    }

    // If we have a patch, validate and potentially repair it
    if (patch) {
      const isValid = await this.validatePatch(request.repo, request.commit_sha, patch, request.file);
      
      if (!isValid) {
        log.warn(`Initial patch validation failed, attempting repair`);
        const repaired = this.repairIncompletePatch(patch, request.file, fileContent);
        
        if (repaired && repaired !== patch) {
          const repairValid = await this.validatePatch(request.repo, request.commit_sha, repaired, request.file);
          if (repairValid) {
            log.success(`Repaired patch is valid`);
            return {
              success: true,
              patch: repaired,
              requires_approval: level === 3,
            };
          }
        }
      } else {
        return {
          success: true,
          patch,
          requires_approval: level === 3,
        };
      }
    }

    // If all else fails, try IterativePatchGenerator as last resort
    // This is the most robust option with 5 rounds of iterative refinement
    // BUT skip if we're already in a fallback chain to prevent infinite recursion
    log.warn(`Standard LLM methods failed, trying IterativePatchGenerator...`);
    if (PatchGenerator.inIterativeFallback) {
      log.warn(`Skipping iterative fallback (already in fallback chain)`);
      return {
        success: false,
        error: 'Standard methods failed and iterative fallback is already active',
        requires_approval: true,
      };
    }
    
    try {
      // Set flag to prevent recursive fallback
      PatchGenerator.inIterativeFallback = true;
      
      const iterativeResult = await this.iterativeGenerator.generatePatchIterative(
        request,
        level,
        {
          maxRounds: 5,
          maxLlmRetries: 2,
          useQwenInteractive: true,
          enableFormatting: true,
          useFullWorkspace: true,
          timeoutPerRound: 180000
        }
      );

      if (iterativeResult.success) {
        log.success(`IterativePatchGenerator succeeded after standard methods failed`);
        return iterativeResult;
      }
      log.warn(`IterativePatchGenerator also failed: ${iterativeResult.error}`);
    } catch (error: any) {
      log.error(`IterativePatchGenerator threw error: ${error.message}`);
    } finally {
      // Clear flag after iterative generation completes
      PatchGenerator.inIterativeFallback = false;
    }

    return {
      success: false,
      error: 'Could not generate valid patch after all methods exhausted',
      requires_approval: true,
    };
  }

  /**
   * Use CLI tools (git diff) to generate a robust patch between two full file contents
   */
  private async generateDiffWithCli(
    filePath: string,
    oldContent: string,
    newContent: string
  ): Promise<string | null> {
    log.step(`generateDiffWithCli called for ${filePath}`);
    
    const oldFile = path.join(this.tempDir, `old-${Date.now()}.txt`);
    const newFile = path.join(this.tempDir, `new-${Date.now()}.txt`);
    
    try {
      fs.writeFileSync(oldFile, oldContent);
      fs.writeFileSync(newFile, newContent);
      
      // Use git diff --no-index for high quality unified diff
      // We use --no-index because these files are not necessarily in a git repo
      try {
        const diff = execSync(`git diff --no-index --patch --unified=3 "${oldFile}" "${newFile}"`, {
          stdio: 'pipe'
        }).toString();
        
        // git diff --no-index output has the temp file paths, we need to fix them
        const lines = diff.split('\n');
        const fixedLines = lines.map((line: string) => {
          if (line.startsWith('--- ')) return `--- a/${filePath}`;
          if (line.startsWith('+++ ')) return `+++ b/${filePath}`;
          return line;
        });
        
        return fixedLines.join('\n');
      } catch (error: any) {
        // git diff returns 1 if there are differences, which execSync treats as error
        if (error.status === 1 && error.stdout) {
          const diff = error.stdout.toString();
          const lines = diff.split('\n');
          const fixedLines = lines.map((line: string) => {
            if (line.startsWith('--- ')) return `--- a/${filePath}`;
            if (line.startsWith('+++ ')) return `+++ b/${filePath}`;
            return line;
          });
          return fixedLines.join('\n');
        }
        log.error(`CLI diff failed: ${error.message}`);
        return null;
      }
    } finally {
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
      if (fs.existsSync(newFile)) fs.unlinkSync(newFile);
    }
  }

  /**
   * Fetch file content with surrounding context
   */
  private async fetchFileWithContext(request: PatchRequest): Promise<FileSnapshot | null> {
    const { repo, commit_sha, file, start_line, end_line } = request;

    log.step(`fetchFileWithContext: ${file} at ${commit_sha || 'HEAD'}`);

    try {
      const [owner, repoName] = repo.split('/');

      // Handle special case for testing with local files
      if (repo === 'pr-autopilot/test-repo') {
        log.detail(`Detected test repository, using local file`);
        const localFilePath = path.join(process.cwd(), file);
        if (!fs.existsSync(localFilePath)) {
          log.error(`Local test file not found: ${localFilePath}`);
          
          // For testing purposes, create a minimal file if it doesn't exist
          if (process.env.NODE_ENV === 'test' || file.includes('test')) {
            log.detail(`Creating minimal test file for testing purposes`);
            let mockContent = '// Test file for patch generation\nconsole.log(\'hello\');\nfunction fetchData(url) {\n  return fetch(url).then(r => r.json());\n}\n// End of test';
            if (request.diff_hunk) {
              const oldLines = request.diff_hunk
                .split('\n')
                .filter((line) => line.startsWith(' ') || line.startsWith('-'))
                .map((line: string) => line.substring(1));
              if (oldLines.length > 0) {
                mockContent = oldLines.join('\n');
              }
            }
            fs.writeFileSync(localFilePath, mockContent);
          } else {
            return null;
          }
        }
        
        const content = fs.readFileSync(localFilePath, 'utf-8');
        const lines = content.split('\n');

        log.detail(`Local file read: ${lines.length} lines`);

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
      }

      // Clone repo shallowly for real repositories
      const repoDir = path.join(this.tempDir, `${owner}-${repoName}`);

      if (!fs.existsSync(repoDir)) {
        log.step(`Cloning repo ${repo}...`);
        const cloneUrl = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${repo}.git`;
        gitExec(`clone --depth=1 ${cloneUrl} ${repoDir}`, this.tempDir, { timeout: 120000 });
        log.step(`Clone complete`);
      } else {
        log.detail(`Using existing clone at ${repoDir}`);
      }

      // Checkout the specific commit
      if (commit_sha) {
        log.step(`Fetching commit ${commit_sha}...`);
        if (fetchAndCheckout(commit_sha, repoDir)) {
          log.step(`Checked out ${commit_sha}`);
        } else {
          log.warn(`Could not checkout ${commit_sha}, using HEAD`);
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
   * Build unified diff from extracted code and original file context
   */
  private createUnifiedDiffFromCode(
    filePath: string,
    startLine: number,
    endLine: number,
    fileData: FileSnapshot,
    newCode: string
  ): string {
    const lines = fileData.lines;
    const newLines = newCode.split('\n');

    // Get the actual lines being replaced (with proper context)
    const contextBefore = 3;
    const contextAfter = 3;

    // Ensure we have valid line numbers
    const safeStartLine = Math.max(1, startLine);
    const safeEndLine = Math.min(lines.length, endLine, safeStartLine + 20); // Cap to avoid huge chunks

    const hunkStartLine = Math.max(1, safeStartLine - contextBefore);
    const contextBeforeCount = safeStartLine - hunkStartLine;
    const contextAfterStart = safeEndLine;
    const contextAfterCount = Math.min(contextAfter, lines.length - contextAfterStart);

    const originalLines = lines.slice(safeStartLine - 1, safeEndLine);

    // Calculate accurate line counts for the hunk header
    // Old: context before + removed lines + context after
    const oldCount = contextBeforeCount + originalLines.length + contextAfterCount;
    // New: context before + added lines + context after
    const newCount = contextBeforeCount + newLines.length + contextAfterCount;

    log.detail(`Creating diff: hunk starts at ${hunkStartLine}, old=${oldCount}, new=${newCount}`);

    // Build the patch with proper format
    let patch = `--- a/${filePath}\n`;
    patch += `+++ b/${filePath}\n`;
    patch += `@@ -${hunkStartLine},${oldCount} +${hunkStartLine},${newCount} @@\n`;

    // Add context lines before (with space prefix)
    for (let i = hunkStartLine - 1; i < safeStartLine - 1 && i < lines.length; i++) {
      patch += ' ' + lines[i] + '\n';
    }

    // Add removed lines (with - prefix)
    for (const line of originalLines) {
      patch += '-' + line + '\n';
    }

    // Add added lines (with + prefix)
    for (const line of newLines) {
      patch += '+' + line + '\n';
    }

    // Add context lines after (with space prefix)
    for (let i = contextAfterStart; i < contextAfterStart + contextAfterCount && i < lines.length; i++) {
      patch += ' ' + lines[i] + '\n';
    }

    // Check for no-op patch
    const removedLines = patch.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));
    const addedLines = patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));

    if (removedLines.length === addedLines.length &&
        removedLines.every((l, i) => l.substring(1) === addedLines[i].substring(1))) {
      log.warn(`No-op patch detected, skipping`);
      return '';
    }

    return patch;
  }

  /**
   * Extract code block from LLM response
   */
  private restoreBaselineIndent(newCode: string, originalLines: string[]): string {
    const leadingWs = (s: string) => (s.match(/^[\t ]*/)?.[0] ?? '');

    // Find the indentation of the first non-empty original line
    const origNonEmpty = originalLines.filter(l => l.trim().length > 0);
    if (!origNonEmpty.length) return newCode;

    // Get the indentation of the first line in the original code block
    const firstOrigIndent = leadingWs(origNonEmpty[0]);
    
    // If the first line has no indentation, no need to adjust
    if (firstOrigIndent.length === 0) return newCode;

    const newLines = newCode.split('\n');
    const newNonEmpty = newLines.filter(l => l.trim().length > 0);
    if (!newNonEmpty.length) return newCode;

    // Get the indentation of the first line in the new code block
    const firstNewIndent = leadingWs(newNonEmpty[0]);

    // If the new code already has the correct indentation, return as is
    if (firstNewIndent === firstOrigIndent) return newCode;

    // Calculate the difference in indentation
    const indentDiff = firstOrigIndent.length - firstNewIndent.length;

    // Adjust all lines in the new code block
    if (indentDiff > 0) {
      // Need to add indentation
      log.detail(`Restoring baseline indent: adding ${indentDiff} spaces to each line`);
      return newLines.map((line: string) => {
        if (line.trim().length > 0) {
          return ' '.repeat(indentDiff) + line;
        }
        return line;
      }).join('\n');
    } else if (indentDiff < 0) {
      // Need to remove indentation (but be careful not to remove more than available)
      const absDiff = Math.abs(indentDiff);
      log.detail(`Adjusting baseline indent: removing ${absDiff} spaces from each line`);
      return newLines.map((line: string) => {
        if (line.trim().length > 0) {
          // Only remove up to the available whitespace
          const currentWs = leadingWs(line);
          const removeCount = Math.min(absDiff, currentWs.length);
          return line.substring(removeCount);
        }
        return line;
      }).join('\n');
    }

    return newCode;
  }

  /**
   * Build prompt for LLM
   */
  private buildLLMPrompt(
    request: PatchRequest,
    fileData: FileSnapshot,
    level: number
  ): string {
    const { file, content, diff_hunk } = request;
    const baseRange = this.resolveTargetRange(request, fileData);
    const start_line = baseRange.start;
    const end_line = baseRange.end;

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
5. Return ONLY the complete fixed code block (the new version of lines ${effectiveStartLine}-${effectiveEndLine})
6. Preserve indentation and code style of the original file
`;
    } else {
      prompt += `
YOUR TASK:
1. Generate the fixed code that addresses the review comment
2. Return ONLY the complete fixed code block (the new version of lines ${effectiveStartLine}-${effectiveEndLine})
3. Do NOT include explanations, markdown formatting instructions, or diff syntax
4. Preserve indentation and code style
`;
    }

    prompt += `
OUTPUT FORMAT:
Return ONLY a single fenced code block containing the complete fixed code for lines ${effectiveStartLine}-${effectiveEndLine}.
Do NOT return a unified diff, do NOT use \`\`\`diff blocks, and do NOT include explanations or prose outside the code block.

${'```'}
// fixed code for lines ${effectiveStartLine}-${effectiveEndLine}
${'```'}

RULES:
1. Maintain the exact same indentation as the original code
2. Return ALL lines from ${effectiveStartLine} to ${effectiveEndLine}, with your fixes applied
3. Do not include line numbers, diff markers (+/-), or any formatting outside the code block
4. Output ONLY the code block — no commentary before or after
`;

    if (level === 3) {
      prompt += `\nNOTE: This is a high-risk change. Be extra careful with the fix.\n`;
    }

    return prompt;
  }

  /**
   * Enhanced code block extraction with better detection
   */
  private extractCodeBlock(response: string): string | null {
    if (!response) return null;
    
    // Try various code block formats with increasing specificity
    
    // Format 1: Standard markdown code block with language
    const langMatch = response.match(/```(?:\w+)?\n([\s\S]*?)\n```/);
    if (langMatch && langMatch[1].trim()) {
      const code = langMatch[1].replace(/\r\n/g, '\n').trimEnd();
      log.detail(`Extracted language-specific code block (${code.length} chars)`);
      return code;
    }

    // Format 2: Language-specific code block that might not end with newline
    const langMatch2 = response.match(/```(?:\w+)?\n([\s\S]*?)```/);
    if (langMatch2 && langMatch2[1].trim()) {
      const code = langMatch2[1].replace(/\r\n/g, '\n').trimEnd();
      log.detail(`Extracted language-specific code block (no trailing newline) (${code.length} chars)`);
      return code;
    }

    // Format 3: Plain code block
    const plainMatch = response.match(/```([\s\S]*?)```/);
    if (plainMatch && plainMatch[1].trim()) {
      const code = plainMatch[1].replace(/\r\n/g, '\n').trimEnd();
      log.detail(`Extracted plain code block (${code.length} chars)`);
      return code;
    }

    // Format 4: Look for indented code blocks or text between specific markers
    // This is a fallback for cases where the LLM doesn't use proper markdown
    const lines = response.split('\n');
    const codeLines: string[] = [];
    let inCodeSection = false;
    
    for (const line of lines) {
      if (line.trim().startsWith('```')) {
        inCodeSection = !inCodeSection;
        continue;
      }
      
      if (inCodeSection) {
        codeLines.push(line);
      }
    }
    
    if (codeLines.length > 0) {
      const code = codeLines.join('\n').replace(/\r\n/g, '\n').trimEnd();
      if (code) {
        log.detail(`Extracted indented code block (${code.length} chars)`);
        return code;
      }
    }

    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(res => setTimeout(res, ms));
  }

  private async callGemini(prompt: string): Promise<{ success: boolean; output?: string; error?: string; errorCode?: string; retryable?: boolean; retryAfterMs?: number }> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { success: false, error: 'GEMINI_API_KEY not configured', errorCode: 'NO_KEY' };

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;

    try {
      log.llmCall(`POST Gemini (${prompt.length} chars)`);
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
      log.llmCall(`POST Mistral mistral-large-2512 (${prompt.length} chars)`);
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

  private async callQwen(prompt: string, request?: PatchRequest): Promise<{ success: boolean; output?: string; error?: string; retryable?: boolean }> {
    const promptFile = path.join(this.tempDir, `qwen-prompt-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, prompt);

    try {
      log.detail(`Calling Qwen with ${prompt.length} chars prompt`);

      // Use qwen with file input instead of piping
      const output = execSync(
        `qwen "$(cat ${promptFile})"`,
        {
          cwd: this.tempDir,
          stdio: 'pipe',
          timeout: 180000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, NO_COLOR: '1' },
        }
      ).toString().trim();

      log.detail(`Qwen returned ${output.length} chars`);

      if (!output) {
        return { success: false, error: 'Qwen returned empty output' };
      }

      return { success: true, output };
    } catch (error: any) {
      log.error(`Qwen failed: ${error.message?.substring(0, 200)}`);
      return { success: false, error: `Qwen failed: ${error.message}` };
    } finally {
      if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
    }
  }

  /**
    * Call LLM with failover: Gemini → Mistral → retries → Qwen (local CLI last resort)
    * USE_QWEN_PRIMARY=true overrides to try Qwen first.
    * QWEN_DISCOVERY_MODE=false disables iterative mode (default is enabled).
    */
  private async callLLM(prompt: string, patchRequest?: PatchRequest, fileContent?: FileSnapshot): Promise<{ success: boolean; output?: string; error?: string }> {
    const geminiAvailable = !!process.env.GEMINI_API_KEY;
    const mistralAvailable = !!process.env.MISTRAL_API_KEY;
    const useQwenPrimary = process.env.USE_QWEN_PRIMARY === 'true';
    // QWEN_DISCOVERY_MODE defaults to true - set to 'false' to disable
    const qwenDiscoveryMode = process.env.QWEN_DISCOVERY_MODE !== 'false';

    // If discovery mode is enabled and we have file content, use IterativePatchGenerator
    // BUT skip if we're already in a fallback chain to prevent infinite recursion
    if (qwenDiscoveryMode && fileContent && patchRequest && !PatchGenerator.inIterativeFallback) {
      log.step(`Using IterativePatchGenerator with project context (QWEN_DISCOVERY_MODE)`);
      // Set flag to prevent recursive fallback
      PatchGenerator.inIterativeFallback = true;
      
      try {
        const result = await this.iterativeGenerator.generatePatchIterative(
          patchRequest,
          2,
          {
            maxRounds: 5,
            maxLlmRetries: 2,
            useQwenInteractive: true,
            enableFormatting: true,
            useFullWorkspace: true,
            timeoutPerRound: 180000
          }
        );
        if (result.success) {
          return { success: true, output: result.patch };
        }
        log.warn(`IterativePatchGenerator failed, falling through to API providers`);
      } catch (error: any) {
        log.error(`IterativePatchGenerator threw error: ${error.message}`);
      } finally {
        // Clear flag after iterative generation completes
        PatchGenerator.inIterativeFallback = false;
      }
    }

    if (useQwenPrimary) {
      log.detail(`USE_QWEN_PRIMARY set, trying Qwen first (${prompt.length} chars)`);
      const qwenResult = await this.callQwen(prompt);
      if (qwenResult.success) return qwenResult;
      log.llmError(`Qwen primary attempt failed, falling through to API providers`);
    }

    if (!geminiAvailable && !mistralAvailable) {
      log.warn(`No API keys configured, using local qwen CLI`);
      if (fileContent && patchRequest && !PatchGenerator.inIterativeFallback) {
        // Use IterativePatchGenerator for better results (but not if already in fallback)
        PatchGenerator.inIterativeFallback = true;
        try {
          const result = await this.iterativeGenerator.generatePatchIterative(
            patchRequest,
            2,
            {
              maxRounds: 3,
              maxLlmRetries: 2,
              useQwenInteractive: true,
              enableFormatting: false,
              useFullWorkspace: false,
              timeoutPerRound: 120000
            }
          );
          if (result.success) {
            return { success: true, output: result.patch };
          }
        } catch (error: any) {
          log.error(`IterativePatchGenerator failed: ${error.message}`);
        } finally {
          PatchGenerator.inIterativeFallback = false;
        }
      }
      return this.callQwen(prompt, patchRequest);
    }

    let lastError: string | undefined;

    // Step 1: Try Gemini
    if (geminiAvailable) {
      log.llmCall(`Trying Gemini (${prompt.length} chars)`);
      const result = await this.callGemini(prompt);
      if (result.success) return result;
      lastError = result.error;
      log.llmError(`Gemini failed: ${result.errorCode ?? 'UNKNOWN'}`);
    }

    // Step 2: Failover to Mistral
    if (mistralAvailable) {
      log.llmCall(`Trying Mistral (${prompt.length} chars)`);
      const result = await this.callMistral(prompt);
      if (result.success) return result;
      lastError = result.error;
      log.llmError(`Mistral failed: ${result.errorCode ?? 'UNKNOWN'}`);
    }

    // Step 3: Exponential backoff retries (per provider), honoring Retry-After
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
        log.llmError(`${provider.name} retry failed: ${result.errorCode ?? 'UNKNOWN'}`);

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

    // Step 4: Last resort — local qwen CLI with project context if available
    log.warn(`All API providers failed, trying local qwen CLI...`);
    if (fileContent && patchRequest) {
      const iterativeResult = await this.callQwenIterative(patchRequest, fileContent, 2, 3);
      if (iterativeResult.success) {
        return { success: true, output: iterativeResult.patch };
      }
    }
    
    const qwenResult = await this.callQwen(prompt, patchRequest);
    if (qwenResult.success) return qwenResult;
    log.llmError(`Qwen fallback also failed`);

    return { success: false, error: lastError ?? 'All LLM attempts failed' };
  }

  /**
   * Extract patch from LLM response
   * Only accepts blocks explicitly fenced as ```diff that contain valid --- a/, +++ b/, @@ headers, and actual change lines
   */
  private extractPatchFromResponse(response: string): string | null {
    log.step(`extractPatchFromResponse called`);

    if (!response || response.trim().length === 0) {
      return null;
    }

    // Only accept blocks explicitly fenced as ```diff that contain proper diff structure
    const diffBlockRegex = /```diff\n([\s\S]*?)```/;
    const diffBlockMatch = response.match(diffBlockRegex);
    if (diffBlockMatch) {
      let content = diffBlockMatch[1].trim();
      content = this.unescapePatchContent(content);

      const hasFileHeaders = /^---\s+a\//.test(content) && /^\+\+\+\s+b\//m.test(content);
      const hasHunkHeader = /^@@\s+-\d+/m.test(content);
      const hasChanges = content.split('\n').some(l => 
        (l.startsWith('+') && !l.startsWith('+++')) || 
        (l.startsWith('-') && !l.startsWith('---'))
      );

      if (hasFileHeaders && hasHunkHeader && hasChanges) {
        log.detail(`Extracted valid diff from explicit \`\`\`diff block (${content.length} chars)`);
        return content;
      }
      log.warn(`\`\`\`diff block found but missing required diff structure, treating as code block`);
    }

    // Also check for raw diff pattern (not in a code block) — same strict validation
    const rawDiffMatch = response.match(/(---\s+a\/[^\n]+\n\+\+\+\s+b\/[^\n]+\n@@[\s\S]*?)(?=\n\w|$)/);
    if (rawDiffMatch) {
      let content = rawDiffMatch[1].trim();
      content = this.unescapePatchContent(content);

      const hasFileHeaders = /^---\s+a\//.test(content) && /^\+\+\+\s+b\//m.test(content);
      const hasHunkHeader = /^@@\s+-\d+/m.test(content);
      const hasChanges = content.split('\n').some(l =>
        (l.startsWith('+') && !l.startsWith('+++')) ||
        (l.startsWith('-') && !l.startsWith('---'))
      );
      
      if (hasFileHeaders && hasHunkHeader && hasChanges) {
        log.detail(`Extracted valid raw diff pattern (${content.length} chars)`);
        return content;
      }
    }

    log.step(`No valid diff found in response, will try code block extraction`);
    return null;
  }

  /**
   * Comprehensive unescaping of patch content
   */
  private unescapePatchContent(content: string): string {
    // First, handle escaped newlines that split lines
    // Convert \\n at end of lines to actual newlines
    content = content.replace(/\\\n/g, '\n');
    
    // Now unescape individual characters
    const unescaped = content
      .replace(/\\-/g, '-')      // \- -> -
      .replace(/\\\+/g, '+')      // \+ -> +
      .replace(/\\n/g, '\n')     // \n -> newline
      .replace(/\\t/g, '\t')     // \t -> tab
      .replace(/\\r/g, '\r')     // \r -> carriage return
      .replace(/\\"/g, '"')      // \" -> "
      .replace(/\\'/g, "'")      // \' -> '
      .replace(/\\\[/g, '[')     // \[ -> [
      .replace(/\\\]/g, ']')     // \] -> ]
      .replace(/\\\{/g, '{')     // \{ -> {
      .replace(/\\\}/g, '}')     // \} -> }
      .replace(/\\\./g, '.')     // \. -> .
      .replace(/\\\*/g, '*')     // \* -> *
      .replace(/\\\\/g, '\\');    // \\ -> \

    // Fix common LLM errors in hunk headers
    // Fix single-@ hunk headers
    let fixed = unescaped.replace(/(^|\n)@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/g, (match, p1, p2, p3, p4, p5) => {
      return `${p1}@@ -${p2}${p3 ? "," + p3 : ""} +${p4}${p5 ? "," + p5 : ""} @@`;
    });
    // Qwen sometimes outputs @ instead of @@
    fixed = fixed.replace(/(^|\n)@ -(\d+)/g, '$1@@ -$2');
    
    // Space before @@
    fixed = fixed.replace(/(^|\n) +@+/g, '$1@@');

    // Fix broken hunk headers with regex artifacts (like $3,$4)
    fixed = fixed.replace(/@@ -(\d+)(?:,\d+)? \+(?:\$3|\d+)(?:,\$4|,\d+)? @@/g, (match, start) => {
      if (match.includes('$')) {
        log.warn(`Found broken hunk header with artifacts: ${match}`);
        return `@@ -${start} +${start} @@`;
      }
      return match;
    });

    // Fix context lines missing space prefix
    // This is now also handled in repairIncompletePatch, but doing it here helps initial validation
    const lines = fixed.split('\n');
    let inHunk = false;
    const fixedLines = lines.map((line: string) => {
      if (line.startsWith('@@')) {
        inHunk = true;
        return line;
      }
      if (line.startsWith('---') || line.startsWith('+++')) {
        inHunk = false;
        return line;
      }
      if (inHunk) {
        if (line === '') return ' ';
        if (!line.startsWith('+') && !line.startsWith('-') && !line.startsWith(' ') && !line.startsWith('\\')) {
          return ' ' + line;
        }
      }
      return line;
    });

    return fixedLines.join('\n');
  }

  private normalizeUnifiedDiff(patch: string, filePath: string): string | null {
    const lines = patch.split('\n');
    const headerIndices: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('--- ')) headerIndices.push(i);
    }

    if (headerIndices.length === 0) {
      return patch.trim();
    }

    if (headerIndices.length > 1) {
      return null;
    }

    const headerIndex = headerIndices[0];
    if (headerIndex + 1 >= lines.length || !lines[headerIndex + 1].startsWith('+++ ')) {
      return null;
    }

    const cleaned = lines.filter((line) => {
      return !line.startsWith('diff --git ')
        && !line.startsWith('index ')
        && !line.startsWith('new file mode ')
        && !line.startsWith('deleted file mode ');
    });

    // Rewrite headers to match the target file path
    cleaned[headerIndex] = `--- a/${filePath}`;
    cleaned[headerIndex + 1] = `+++ b/${filePath}`;

    const hasHunk = cleaned.some((line) => line.startsWith('@@ '));
    if (!hasHunk) {
      return null;
    }

    return cleaned.join('\n').trim();
  }

  private resolveTargetRange(request: PatchRequest, fileData: FileSnapshot): { start: number; end: number } {
    const totalLines = fileData.lines.length;
    let start = request.start_line;
    let end = request.end_line;

    if (start >= 1 && end >= start && end <= totalLines) {
      return { start, end };
    }

    if (request.diff_hunk) {
      const oldLines = request.diff_hunk
        .split('\n')
        .filter((line) => line.startsWith(' ') || line.startsWith('-'))
        .map((line: string) => line.substring(1));

      if (oldLines.length > 0) {
        const matchIndex = this.findSequence(fileData.lines, oldLines);
        if (matchIndex !== -1) {
          return { start: matchIndex + 1, end: matchIndex + oldLines.length };
        }
      }
    }

    if (totalLines === 0) {
      return { start: 1, end: 1 };
    }

    start = Math.min(Math.max(1, start), totalLines);
    end = Math.min(Math.max(start, end), totalLines);

    return { start, end };
  }

  private findSequence(haystack: string[], needle: string[]): number {
    if (needle.length === 0 || needle.length > haystack.length) return -1;

    // Pass 1: exact match
    for (let i = 0; i <= haystack.length - needle.length; i++) {
      let matches = true;
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) {
          matches = false;
          break;
        }
      }
      if (matches) return i;
    }

    // Pass 2: whitespace-normalized match (trim trailing, collapse internal runs)
    const normalize = (s: string) => s.trimEnd().replace(/\s+/g, ' ');
    const normalizedNeedle = needle.map((s: string) => normalize(s));
    for (let i = 0; i <= haystack.length - needle.length; i++) {
      let matches = true;
      for (let j = 0; j < needle.length; j++) {
        if (normalize(haystack[i + j]) !== normalizedNeedle[j]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        log.detail(`findSequence: fuzzy match at line ${i + 1} (exact match failed)`);
        return i;
      }
    }

    return -1;
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

      try {
        // Try to checkout the specific commit, but don't fail if it doesn't exist
        if (commitSha) {
          if (fetchAndCheckout(commitSha, repoDir)) {
            log.step(`Checked out commit ${commitSha}`);
          } else {
            log.warn(`Could not checkout ${commitSha}, using HEAD`);
          }
        }

        // Try to apply the patch with --check (dry-run)
        log.step(`Running: git apply --check ${patchFile}`);
        try {
          gitExec(`apply --check --verbose "${patchFile}"`, repoDir, { pipe: true, timeout: 10000 });
          log.success(`Patch validation PASSED`);
          fs.unlinkSync(patchFile);
          return true;
        } catch (error: any) {
          log.warn(`Strict validation failed, trying fuzzy match...`);
          try {
            gitExec(`apply --check --ignore-space-change --ignore-whitespace --recount --verbose "${patchFile}"`, repoDir, { pipe: true, timeout: 10000 });
            log.success(`Fuzzy validation PASSED`);
            fs.unlinkSync(patchFile);
            return true;
          } catch (fuzzyError: any) {
            // If verbose check failed, try to get more specific info
            log.error(`Patch validation FAILED: ${error.message}`);
            
            // Log specific git error details if available
            if (error.stdout) log.detail(`Git stdout: ${error.stdout}`);
            if (error.stderr) log.detail(`Git stderr: ${error.stderr}`);
            
            log.detail(`Failed patch content:\n${patch}`);
            fs.unlinkSync(patchFile);
            return false;
          }
        }
      } catch (error: any) {
        log.error(`Error during validation: ${error.message}`);
        return false;
      }
    } catch (error: any) {
      log.error(`Unexpected error during validation: ${error.message}`);
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

  /**
   * Repair an incomplete or malformed patch by synchronizing context with actual file content
   * Fixes common issues: overlong removals, extra spaces/empty lines, misaligned hunks, and drifted files
   */
  private repairIncompletePatch(
    patch: string,
    filePath: string,
    fileContent: FileSnapshot
  ): string | null {
    log.step(`repairIncompletePatch called for ${filePath}`);

    if (!patch || !patch.trim()) {
      return null;
    }

    let workingPatch = patch
      .replace(/(^|\n)@ -(\d+)/g, '$1@@ -$2')
      .replace(/(^|\n) +@@/g, '$1@@');

    const lines = workingPatch.split('\n');
    const resultLines: string[] = [];
    let i = 0;

    // Preserve file headers
    while (i < lines.length && !lines[i].startsWith('@@')) {
      resultLines.push(lines[i]);
      i++;
    }

    if (i >= lines.length) {
      log.detail(`No hunk header found in patch`);
      return null;
    }

    while (i < lines.length) {
      if (lines[i].startsWith('@@')) {
        let hunkHeader = lines[i];
        if (hunkHeader.startsWith('@ ') && !hunkHeader.startsWith('@@ ')) {
          hunkHeader = '@@' + hunkHeader.substring(1);
        }

        const hunkMatch = hunkHeader.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (!hunkMatch) {
          log.detail(`Could not parse hunk header: ${hunkHeader}`);
          resultLines.push(lines[i]);
          i++;
          continue;
        }

        let oldStart = parseInt(hunkMatch[1], 10);
        const declaredOldCount = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;

        // Collect hunk body lines
        i++;
        const hunkBody: string[] = [];
        while (i < lines.length) {
          const line = lines[i];
          if (line.startsWith('@@') || line.startsWith('diff') || line.startsWith('---') || line.startsWith('index')) {
            break;
          }
          hunkBody.push(line);
          i++;
        }

        // Separate the LLM's additions from its context/removals
        const addedLines: string[] = [];
        const llmOldLines: string[] = [];
        for (const line of hunkBody) {
          if (line.startsWith('+')) {
            addedLines.push(line);
          } else {
            llmOldLines.push(line.startsWith('-') ? line.substring(1) : (line.startsWith(' ') ? line.substring(1) : line));
          }
        }

        // Re-anchor: verify that the old lines match the file at oldStart
        // If not, search within ±30 lines for a better anchor using fuzzy matching
        const fileLines = fileContent.lines;
        let anchored = false;
        let actualStart = oldStart;

        if (llmOldLines.length > 0) {
          // First, try exact match at the specified position
          if (this.linesMatchAt(fileLines, oldStart - 1, llmOldLines)) {
            anchored = true;
            actualStart = oldStart;
          } else {
            // If exact match fails, search for the best match nearby
            const searchRadius = 30;
            const searchStart = Math.max(0, oldStart - 1 - searchRadius);
            const searchEnd = Math.min(fileLines.length, oldStart - 1 + searchRadius);
            
            let bestMatch = -1;
            let bestScore = -1;
            
            for (let s = searchStart; s < searchEnd; s++) {
              // Calculate match score based on number of matching lines
              let score = 0;
              for (let j = 0; j < llmOldLines.length && (s + j) < fileLines.length; j++) {
                if (this.linesMatchExactly(fileLines[s + j], llmOldLines[j])) {
                  score += 1;
                } else if (this.linesMatchFuzzily(fileLines[s + j], llmOldLines[j])) {
                  score += 0.7; // Partial credit for fuzzy matches
                }
              }
              
              if (score > bestScore && score > llmOldLines.length * 0.5) { // Require majority match
                bestScore = score;
                bestMatch = s;
              }
            }
            
            if (bestMatch !== -1) {
              log.detail(`Re-anchored hunk from line ${oldStart} to line ${bestMatch + 1}`);
              actualStart = bestMatch + 1;
              anchored = true;
            }
          }
        }

        // Rebuild the hunk using actual file content for context and removals
        const newHunkLines: string[] = [];
        let currentFileLine = actualStart;

        for (const line of hunkBody) {
          if (line.startsWith('+')) {
            // Add the new line as provided
            newHunkLines.push(line);
          } else if (line.startsWith('-')) {
            // Replace with actual file content for the line being removed
            if (currentFileLine >= 1 && currentFileLine <= fileLines.length) {
              newHunkLines.push('-' + fileLines[currentFileLine - 1]);
              currentFileLine++;
            } else {
              // If we're past the end of the file, skip this removal
              log.detail(`Skipping overlong removal at line ${currentFileLine} (file has ${fileLines.length} lines)`);
            }
          } else if (line.startsWith(' ')) {
            // Context line - use actual file content
            if (currentFileLine >= 1 && currentFileLine <= fileLines.length) {
              newHunkLines.push(' ' + fileLines[currentFileLine - 1]);
              currentFileLine++;
            } else {
              // If we're past the end of the file, treat as addition
              newHunkLines.push('+' + line.substring(1)); // Convert context to addition
            }
          } else if (line.trim() !== '') {
            // Non-diff line (might be a line that should be context)
            // Try to match it against the actual file content
            if (currentFileLine >= 1 && currentFileLine <= fileLines.length) {
              if (this.linesMatchExactly(fileLines[currentFileLine - 1], line)) {
                newHunkLines.push(' ' + fileLines[currentFileLine - 1]);
                currentFileLine++;
              } else {
                // If it doesn't match, treat as addition
                newHunkLines.push('+' + line);
              }
            } else {
              newHunkLines.push('+' + line);
            }
          } else {
            // Empty line - preserve it
            newHunkLines.push(line);
          }
        }

        // Recalculate counts accurately
        const finalRemoved = newHunkLines.filter(l => l.startsWith('-')).length;
        const finalContext = newHunkLines.filter(l => l.startsWith(' ')).length;
        const finalAdded = newHunkLines.filter(l => l.startsWith('+')).length;
        const finalOldCount = finalContext + finalRemoved;
        const finalNewCount = finalContext + finalAdded;

        log.detail(`Repaired hunk: -${actualStart},${finalOldCount} +${actualStart},${finalNewCount}${anchored ? ' (anchored)' : ' (unanchored)'}`);

        resultLines.push(`@@ -${actualStart},${finalOldCount} +${actualStart},${finalNewCount} @@`);
        resultLines.push(...newHunkLines);
      } else {
        resultLines.push(lines[i]);
        i++;
      }
    }

    return resultLines.join('\n');
  }

  /**
   * Check if lines match exactly (ignoring trailing whitespace)
   */
  private linesMatchExactly(line1: string, line2: string): boolean {
    return line1.trimEnd() === line2.trimEnd();
  }

  /**
   * Check if lines match fuzzily (similar content with minor differences)
   */
  private linesMatchFuzzily(line1: string, line2: string): boolean {
    // Normalize whitespace and compare
    const norm1 = line1.replace(/\s+/g, ' ').trim();
    const norm2 = line2.replace(/\s+/g, ' ').trim();
    return norm1 === norm2;
  }

  private linesMatchAt(fileLines: string[], startIdx: number, toMatch: string[]): boolean {
    if (startIdx < 0 || startIdx + toMatch.length > fileLines.length) return false;
    for (let j = 0; j < toMatch.length; j++) {
      if (fileLines[startIdx + j].trim() !== toMatch[j].trim()) {
        return false;
      }
    }
    return true;
  }

  /**
   * Setup project directory for Qwen with full context
   */
  private async getQwenProjectContext(
    request: PatchRequest,
    fileContent: FileSnapshot
  ): Promise<{ projectDir: string; relatedFiles: string[] } | null> {
    log.step(`getQwenProjectContext called for ${request.repo}`);

    const [owner, repoName] = request.repo.split('/');
    const repoDir = path.join(this.tempDir, `${owner}-${repoName}`);

    if (!fs.existsSync(repoDir)) {
      log.warn(`Repo not cloned at ${repoDir}, cannot get full project context`);
      return null;
    }

    // Find related files based on imports, class references, etc.
    const relatedFiles: string[] = [];
    const fileExt = path.extname(request.file);

    try {
      // Get all files with same extension in the project
      const findOutput = execSync(
        `find "${repoDir}" -type f -name "*${fileExt}" ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/__pycache__/*" 2>/dev/null | head -50`,
        { encoding: 'utf-8', timeout: 10000 }
      ).toString().trim();

      const allFiles = findOutput.split('\n').filter(f => f.length > 0);

      // Prioritize files that might be related based on naming
      const targetBase = path.basename(request.file, fileExt);
      for (const fullPath of allFiles) {
        const relPath = path.relative(repoDir, fullPath);
        if (relPath === request.file) continue;

        // Check for import relationships or similar naming
        const fileBase = path.basename(relPath, fileExt);
        if (relPath.includes(targetBase) ||
            targetBase.includes(fileBase) ||
            fileBase.includes(targetBase.replace(/s$/, '')) || // singular/plural
            fileBase.includes(targetBase + '_')) {
          relatedFiles.push(relPath);
        }
      }

      // Limit to most relevant files
      const limitedRelated = relatedFiles.slice(0, 10);
      log.detail(`Found ${limitedRelated.length} related files for context`);

      return { projectDir: repoDir, relatedFiles: limitedRelated };
    } catch (error: any) {
      log.warn(`Failed to find related files: ${error.message}`);
      return { projectDir: repoDir, relatedFiles: [] };
    }
  }

  /**
   * Call Qwen CLI with full project context
   * This allows Qwen to see the entire codebase for better fixes
   */
  private async callQwenWithProjectContext(
    prompt: string,
    request: PatchRequest,
    fileContent: FileSnapshot,
    mode: 'single' | 'iterative' | 'discovery' = 'single'
  ): Promise<{ success: boolean; output?: string; error?: string; additionalEdits?: string[] }> {
    log.step(`callQwenWithProjectContext called in ${mode} mode`);

    const context = await this.getQwenProjectContext(request, fileContent);
    let projectDir: string;
    let relatedFiles: string[] = [];

    if (!context) {
      log.step(`No context found, performing dedicated clone for Qwen...`);
      const [owner, repoName] = request.repo.split('/');
      projectDir = path.join(this.tempDir, `${owner}-${repoName}`);
      if (!fs.existsSync(projectDir)) {
        const cloneUrl = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${request.repo}.git`;
        gitExec(`clone --depth=1 ${cloneUrl} ${projectDir}`, this.tempDir, { timeout: 120000 });
        if (request.commit_sha) {
          if (fetchAndCheckout(request.commit_sha, projectDir)) {
            log.step(`Checked out ${request.commit_sha} in Qwen clone`);
          } else {
            log.warn(`Could not checkout ${request.commit_sha} in Qwen clone, using default branch`);
          }
        }
      }
    } else {
      projectDir = context.projectDir;
      relatedFiles = context.relatedFiles;
    }

    // Build comprehensive prompt with project context
    let enhancedPrompt = prompt;

    if (mode === 'iterative' || mode === 'discovery') {
      enhancedPrompt += `

PROJECT CONTEXT:
This file is part of a larger codebase. Below are related files that may need to be considered:

`;

      // Include file list/structure
      try {
        const fileList = execSync(`find . -maxdepth 3 -not -path '*/.*'`, { cwd: projectDir, encoding: 'utf-8' });
        enhancedPrompt += `\nPROJECT STRUCTURE (subset):\n${fileList}\n`;
      } catch (e) { /* ignore */ }

      // Include content from related files
      for (const relFile of relatedFiles.slice(0, 5)) {
        try {
          const fullPath = path.join(projectDir, relFile);
          if (fs.existsSync(fullPath)) {
            const content = fs.readFileSync(fullPath, 'utf-8');
            // Include first 100 lines of related file
            const lines = content.split('\n').slice(0, 100).join('\n');
            enhancedPrompt += `\n--- FILE: ${relFile} ---\n${lines}\n${content.split('\n').length > 100 ? '... (truncated)' : ''}\n`;
          }
        } catch (e) {
          // Skip files we can't read
        }
      }

      if (mode === 'discovery') {
        enhancedPrompt += `

DISCOVERY MODE:
Analyze the codebase and identify if the fix requested requires changes in multiple files. 
Consider cross-file dependencies, interface changes, and required imports.

If multiple files need changes, list ALL of them.

RESPONSE FORMAT:
1. First, provide the unified diff for the primary file: ${request.file}
2. Then, add a section titled "ADDITIONAL_EDITS:" followed by a JSON array of objects:
   [
     {
       "file": "path/to/file",
       "reason": "why this needs to change",
       "suggested_change": "code snippet or description"
     }
   ]

If no other files need changes, still provide the ADDITIONAL_EDITS section with an empty array [].
`;
      }
    }

    // Write prompt to temp file
    const promptFile = path.join(this.tempDir, `qwen-prompt-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, enhancedPrompt);

    try {
      log.detail(`Calling Qwen with ${enhancedPrompt.length} chars prompt in ${mode} mode`);

      // Use same qwen CLI syntax as callQwen
      const output = execSync(
        `qwen "$(cat ${promptFile})"`,
        {
          cwd: projectDir,
          stdio: 'pipe',
          timeout: 300000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, NO_COLOR: '1' },
        }
      ).toString().trim();

      log.detail(`Qwen returned ${output.length} chars`);

      if (!output) {
        return { success: false, error: 'Qwen returned empty output' };
      }

      // Parse additional edits if in discovery mode
      let additionalEdits: string[] | undefined;
      if (mode === 'discovery') {
        const additionalMatch = output.match(/ADDITIONAL_EDITS:?\s*([\s\S]*?)(?:\n\n|$)/i);
        if (additionalMatch) {
          try {
            const editsText = additionalMatch[1].trim();
            // Try to parse as JSON array
            if (editsText.startsWith('[')) {
              const parsed = JSON.parse(editsText);
              additionalEdits = parsed.map((e: any) => `${e.file}: ${e.reason}`);
            } else {
              // Treat as plain text list
              additionalEdits = editsText.split('\n').filter((l: string) => l.trim());
            }
            log.detail(`Qwen suggested ${additionalEdits?.length || 0} additional edits`);
          } catch (e) {
            log.warn(`Could not parse additional edits: ${e}`);
          }
        }
      }

      return { success: true, output, additionalEdits };
    } catch (error: any) {
      log.error(`Qwen with project context failed: ${error.message?.substring(0, 200)}`);
      return { success: false, error: `Qwen failed: ${error.message}` };
    } finally {
      if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
    }
  }

  /**
   * Iterative mode: Call Qwen multiple times to refine the fix
   */
  private async callQwenIterative(
    request: PatchRequest,
    fileContent: FileSnapshot,
    level: number,
    maxIterations: number = 3,
    useCliTools: boolean = false
  ): Promise<PatchResult> {
    log.step(`callQwenIterative called with max ${maxIterations} iterations`);

    const baseRange = this.resolveTargetRange(request, fileContent);
    let effectiveStartLine = baseRange.start;
    let effectiveEndLine = baseRange.end;

    if (request.start_line === request.end_line) {
      effectiveStartLine = Math.max(1, baseRange.start - 20);
      effectiveEndLine = Math.min(fileContent.lines.length, baseRange.end + 5);
    }

    const originalLines = fileContent.lines.slice(effectiveStartLine - 1, effectiveEndLine);
    let currentPrompt = this.buildLLMPrompt(request, fileContent, level);

    // Initial discovery phase to see if more files need changes
    log.step(`Starting Qwen discovery phase...`);
    const discoveryResult = await this.callQwenWithProjectContext(
      currentPrompt,
      request,
      fileContent,
      'discovery'
    );

    if (discoveryResult.success && discoveryResult.additionalEdits && discoveryResult.additionalEdits.length > 0) {
      log.step(`Qwen discovered additional edits needed:`);
      for (const edit of discoveryResult.additionalEdits) {
        log.detail(`  - ${edit}`);
      }
      // Add discovery findings to the prompt for subsequent iterations
      currentPrompt += `\n\nADDITIONAL CONTEXT FROM PREVIOUS SCAN:\nQwen identified that the following additional changes may be needed for a complete fix:\n${discoveryResult.additionalEdits.join('\n')}\nEnsure the current patch is consistent with these findings.\n`;
    }

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      log.step(`Qwen iteration ${iteration + 1}/${maxIterations}`);

      // Use project context on later iterations
      const mode = iteration === 0 ? 'single' : 'iterative';
      const qwenResult = await this.callQwenWithProjectContext(
        currentPrompt,
        request,
        fileContent,
        mode
      );

      if (!qwenResult.success || !qwenResult.output) {
        log.warn(`Qwen iteration ${iteration + 1} failed: ${qwenResult.error}`);
        continue;
      }

      // Extract patch
      let patch = this.extractPatchFromResponse(qwenResult.output);

      if (!patch) {
        const codeBlock = this.extractCodeBlock(qwenResult.output);
        if (codeBlock) {
          const normalized = this.restoreBaselineIndent(codeBlock, originalLines);
          
          if (useCliTools) {
            const beforeLines = fileContent.lines.slice(0, effectiveStartLine - 1);
            const afterLines = fileContent.lines.slice(effectiveEndLine);
            const newFullContent = [...beforeLines, normalized, ...afterLines].join('\n');
            
            patch = await this.generateDiffWithCli(request.file, fileContent.full_content, newFullContent);
            if (!patch) {
              patch = this.createUnifiedDiffFromCode(request.file, effectiveStartLine, effectiveEndLine, fileContent, normalized);
            }
          } else {
            patch = this.createUnifiedDiffFromCode(request.file, effectiveStartLine, effectiveEndLine, fileContent, normalized);
          }
        }
      }

      if (patch) {
        // Try to validate
        const isValid = await this.validatePatch(request.repo, request.commit_sha, patch, request.file);

        if (isValid) {
          log.success(`Qwen iteration ${iteration + 1} produced valid patch`);

          // If discovery mode found additional edits, log them
          if (qwenResult.additionalEdits && qwenResult.additionalEdits.length > 0) {
            log.step(`Qwen suggests additional edits may be needed in related files:`);
            for (const edit of qwenResult.additionalEdits) {
              log.detail(`  - ${edit}`);
            }
          }

          return {
            success: true,
            patch,
            requires_approval: level === 3,
          };
        } else {
          log.warn(`Qwen iteration ${iteration + 1} patch invalid, attempting repair`);

          // Try to repair incomplete patch
          const repaired = this.repairIncompletePatch(patch, request.file, fileContent);
          if (repaired && repaired !== patch) {
            const repairValid = await this.validatePatch(request.repo, request.commit_sha, repaired, request.file);
            if (repairValid) {
              log.success(`Repaired patch is valid`);
              return {
                success: true,
                patch: repaired,
                requires_approval: level === 3,
              };
            }
          }

          // Update prompt for next iteration with feedback
          currentPrompt += `\n\nPREVIOUS ATTEMPT FAILED:\nThe previous patch did not apply cleanly. Please try again, ensuring:\n1. The diff format is correct (---a/, +++ b/, @@ lines)\n2. Context lines match exactly (including whitespace)\n3. Line numbers in the @@ header are accurate\n\nPrevious output:\n${qwenResult.output.substring(0, 500)}\n`;
        }
      } else {
        log.warn(`Qwen iteration ${iteration + 1} did not produce extractable patch`);
        currentPrompt += `\n\nPREVIOUS ATTEMPT: Could not extract a valid diff. Please respond with a proper unified diff format.\n`;
      }
    }

    return {
      success: false,
      error: `Qwen failed to produce valid patch after ${maxIterations} iterations`,
      requires_approval: true,
    };
  }
}
