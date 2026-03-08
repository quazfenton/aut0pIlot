import { PatchRequest, PatchResult } from './types';
import { GitOps } from './git-ops';
import { PatchErrorAnalyzer, PatchErrorAnalysis } from './patch-error-analyzer';
import { QwenInteractiveSession, QwenInteractiveOptions } from './qwen-interactive-session';
import { DiffUtils } from './utils/diff-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const log = {
  header: (msg: string) => console.log(`\n\x1b[1;38;5;208m[ITERATIVE-PATCH] ══ ${msg} ══\x1b[0m`),
  step: (msg: string) => console.log(`\x1b[32m[STEP]\x1b[0m ${msg}`),
  detail: (msg: string) => console.log(`\x1b[2m[DETAIL]\x1b[0m ${msg}`),
  warn: (msg: string) => console.log(`\x1b[1;33m[WARN]\x1b[0m ${msg}`),
  error: (msg: string) => console.log(`\x1b[1;31m[ERROR]\x1b[0m ${msg}`),
  success: (msg: string) => console.log(`\x1b[1;32m[SUCCESS]\x1b[0m ${msg}`),
  retry: (msg: string) => console.log(`\x1b[38;5;221m[RETRY]\x1b[0m ${msg}`),
  llm: (msg: string) => console.log(`\x1b[38;5;201m[LLM]\x1b[0m ${msg}`),
  validation: (msg: string) => console.log(`\x1b[38;5;51m[VALIDATION]\x1b[0m ${msg}`),
};

interface PatchGenerationAttempt {
  round: number;
  method: 'mechanical' | 'traditional_llm' | 'qwen_interactive' | 'repair';
  patch?: string;
  error?: string;
  validationError?: string;
  duration: number;
}

export interface IterativePatchOptions {
  maxRounds?: number;
  maxLlmRetries?: number;
  useQwenInteractive?: boolean;
  timeoutPerRound?: number;
  enableFormatting?: boolean;
  useFullWorkspace?: boolean;
}

export class IterativePatchGenerator {
  private tempDir: string;
  private errorAnalyzer: PatchErrorAnalyzer;
  private attemptHistory: PatchGenerationAttempt[] = [];

  constructor(private gitOps: GitOps) {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iterative-patch-'));
    this.errorAnalyzer = new PatchErrorAnalyzer();
  }

  /**
   * Generate patch with iterative retry logic that learns from errors
   */
  async generatePatchIterative(
    request: PatchRequest,
    level: number = 2,
    options: IterativePatchOptions = {}
  ): Promise<PatchResult> {
    const {
      maxRounds = 5,
      maxLlmRetries = 2,
      useQwenInteractive = true,
      timeoutPerRound = 120000,
      enableFormatting = true,
      useFullWorkspace = true
    } = options;

    log.header(`Starting iterative patch generation for ${request.file}`);
    log.step(`Max rounds: ${maxRounds}, Max LLM retries: ${maxLlmRetries}`);
    log.detail(`Review comment: ${request.content.substring(0, 200)}...`);

    let lastError: string | undefined;
    let lastPatch: string | undefined;
    let validationErrors: string[] = [];

    for (let round = 1; round <= maxRounds; round++) {
      log.step(`\n========== ROUND ${round}/${maxRounds} ==========`);
      const roundStart = Date.now();

      try {
        // Step 1: Try mechanical extraction first (always)
        if (round === 1) {
          log.step('Trying mechanical extraction (GitHub suggestions)');
          const mechanicalResult = await this.tryMechanicalExtraction(request);
          if (mechanicalResult.success) {
            log.success('Mechanical extraction succeeded!');
            return mechanicalResult;
          }
          log.warn('Mechanical extraction failed or no suggestions found');
        }

        // Step 2: Try traditional LLM approach (with retries)
        if (round <= maxLlmRetries) {
          log.step(`Trying traditional LLM approach (attempt ${round})`);
          const llmResult = await this.tryTraditionalLLM(request, level, {
            previousAttempts: this.attemptHistory,
            lastError,
            validationErrors
          });

          if (llmResult.success && llmResult.patch) {
            // Validate the patch with DiffUtils
            const validation = DiffUtils.validateDiff(llmResult.patch);
            if (validation.valid) {
              // Also verify with git apply
              const gitValid = await this.validatePatchWithGit(request, llmResult.patch);
              if (gitValid) {
                log.success('Traditional LLM patch validated successfully!');
                return llmResult;
              }
              log.warn('Patch passed structure validation but failed git apply');
            }

            // Patch failed validation - analyze errors for next round
            log.warn(`LLM patch failed validation: ${validation.errors.join(', ')}`);
            lastError = validation.errors.join('; ') || llmResult.error;
            validationErrors = validation.warnings;
            lastPatch = llmResult.patch;

            // Record this attempt
            this.recordAttempt({
              round,
              method: 'traditional_llm',
              patch: llmResult.patch,
              validationError: validation.errors.join('; '),
              duration: Date.now() - roundStart
            });

            continue; // Try next round with error feedback
          }

          lastError = llmResult.error;
          this.recordAttempt({
            round,
            method: 'traditional_llm',
            error: llmResult.error,
            duration: Date.now() - roundStart
          });
        }

        // Step 3: Try Qwen interactive session (more powerful but slower)
        if (useQwenInteractive && round > 1) {
          log.step('Trying Qwen interactive editing session');
          const qwenResult = await this.tryQwenInteractive(request, {
            previousAttempts: this.attemptHistory,
            lastError,
            validationErrors
          }, {
            enableFormatting,
            useFullWorkspace,
            timeoutMs: timeoutPerRound
          });

          if (qwenResult.success && qwenResult.patch) {
            log.success('Qwen interactive session succeeded!');
            if (qwenResult.formattingApplied) {
              log.detail('Formatting was applied to generated code');
            }
            if (qwenResult.additionalEdits && qwenResult.additionalEdits.length > 0) {
              log.detail(`Additional files modified: ${qwenResult.additionalEdits.map(e => e.file).join(', ')}`);
            }
            return {
              success: true,
              patch: qwenResult.patch,
              requires_approval: false
            };
          }

          log.warn(`Qwen interactive session failed: ${qwenResult.error}`);
          if (qwenResult.validationErrors) {
            lastError = qwenResult.validationErrors.join('; ');
            validationErrors = qwenResult.validationErrors;
          } else {
            lastError = qwenResult.error;
          }

          this.recordAttempt({
            round,
            method: 'qwen_interactive',
            patch: qwenResult.patch,
            error: qwenResult.error,
            validationError: qwenResult.validationErrors?.join('; '),
            duration: Date.now() - roundStart
          });
        }

        // Step 4: Final repair attempt (if we have a previous patch to repair)
        if (lastPatch && round === maxRounds) {
          log.step('Attempting final repair of best previous patch');
          const repairedPatch = await this.repairPatch(request, lastPatch, validationErrors);

          if (repairedPatch) {
            const validation = DiffUtils.validateDiff(repairedPatch);
            if (validation.valid) {
              const gitValid = await this.validatePatchWithGit(request, repairedPatch);
              if (gitValid) {
                log.success('Final repair succeeded!');
                return {
                  success: true,
                  patch: repairedPatch,
                  requires_approval: false
                };
              }
              log.warn('Repaired patch passed structure validation but failed git apply');
            }
            log.warn('Final repair still failed validation');
          }
        }

      } catch (error: any) {
        log.error(`Round ${round} failed with exception: ${error.message}`);
        lastError = error.message;
        this.recordAttempt({
          round,
          method: 'error',
          error: error.message,
          duration: Date.now() - roundStart
        });
      }
    }

    // All rounds exhausted
    log.error(`\nPatch generation failed after ${maxRounds} rounds`);
    log.detail(`Attempt history: ${JSON.stringify(this.attemptHistory, null, 2)}`);

    return {
      success: false,
      error: `Failed to generate valid patch after ${maxRounds} rounds. Last error: ${lastError || 'unknown'}`,
      requires_approval: false
    };
  }

  /**
   * Try mechanical extraction from GitHub suggestion blocks
   */
  private async tryMechanicalExtraction(request: PatchRequest): Promise<PatchResult> {
    const suggestions = request.suggestions || [];

    if (suggestions.length === 0) {
      // Try to extract from content
      const suggestionRegex = /```suggestion\b[^\n]*\n([\s\S]*?)```/g;
      let match;
      while ((match = suggestionRegex.exec(request.content)) !== null) {
        const code = match[1].replace(/\r\n/g, '\n').trimEnd();
        if (code) {
          suggestions.push({ code, source: 'github', section: 'suggestion' });
        }
      }
    }

    if (suggestions.length === 0) {
      return { success: false, error: 'No suggestions found', requires_approval: false };
    }

    log.detail(`Found ${suggestions.length} suggestion(s)`);

    // Try each suggestion
    for (const suggestion of suggestions) {
      try {
        const patch = await this.createMechanicalPatch(request, suggestion.code);
        const validation = await this.validatePatch(request, patch);

        if (validation.valid) {
          log.success('Mechanical patch validated!');
          return {
            success: true,
            patch,
            requires_approval: false
          };
        }

        log.detail(`Suggestion failed validation: ${validation.error}`);
      } catch (error: any) {
        log.detail(`Suggestion processing failed: ${error.message}`);
      }
    }

    return { success: false, error: 'All mechanical suggestions failed', requires_approval: false };
  }

  /**
   * Create a mechanical patch from a suggestion
   */
  private async createMechanicalPatch(request: PatchRequest, suggestionCode: string): Promise<string> {
    const newLines = suggestionCode.split('\n');

    const fileContent = await this.fetchFileContent(request);
    if (!fileContent) {
      throw new Error('Could not fetch file content for mechanical patch');
    }

    const fileLines = fileContent.split('\n').filter(line => line !== undefined);
    const oldLines = fileLines.slice(request.start_line - 1, request.end_line);

    const maxContext = Math.min(3, request.start_line - 1, fileLines.length - request.end_line);
    const contextStart = request.start_line - 1 - maxContext;
    const contextBefore = fileLines.slice(contextStart, request.start_line - 1);
    const contextAfter = fileLines.slice(request.end_line, request.end_line + maxContext);

    const oldStart = contextStart + 1;
    const totalOldCount = contextBefore.length + oldLines.length + contextAfter.length;
    const totalNewCount = contextBefore.length + newLines.length + contextAfter.length;

    let patch = `--- a/${request.file}\n`;
    patch += `+++ b/${request.file}\n`;
    patch += `@@ -${oldStart},${totalOldCount} +${oldStart},${totalNewCount} @@\n`;

    for (const line of contextBefore) {
      patch += ` ${line}\n`;
    }
    for (const line of oldLines) {
      patch += `-${line}\n`;
    }
    for (const line of newLines) {
      patch += `+${line}\n`;
    }
    for (const line of contextAfter) {
      patch += ` ${line}\n`;
    }

    return patch;
  }

  /**
   * Try traditional LLM approach with error feedback
   */
  private async tryTraditionalLLM(
    request: PatchRequest,
    level: number,
    context: {
      previousAttempts: PatchGenerationAttempt[];
      lastError?: string;
      validationErrors?: string[];
    }
  ): Promise<PatchResult> {
    // Import PatchGenerator dynamically to avoid circular dependency
    const { PatchGenerator } = await import('./patch-generator');
    // CRITICAL: Pass the same gitOps instance to avoid multiple clone directories
    const generator = new PatchGenerator(this.gitOps);

    // Enhance request with error feedback
    const enhancedRequest = this.enhanceRequestWithFeedback(request, context);

    try {
      // CRITICAL: Avoid toggling `process.env.QWEN_DISCOVERY_MODE` globally due to race conditions.
      // Instead, a request-scoped option is passed to PatchGenerator.
      // This ensures PatchGenerator.callLLM() does not call back into IterativePatchGenerator
      // (Qwen discovery mode) when already within an iterative generation process,
      // preventing infinite recursion.
      // The previous `process.env` manipulation has been removed.
      
      try {
        // Pass an option to disable Qwen discovery mode for this specific patch generation call.
        const result = await generator.generatePatch(enhancedRequest, level, false, { disableQwenDiscoveryMode: true });
        
        if (result.success && result.patch) {
      
      try {
        const result = await generator.generatePatch(enhancedRequest, level, false);
        
        if (result.success && result.patch) {
          log.detail(`Traditional LLM generated patch (${result.patch.length} chars)`);
        }
        
        return result;
      } finally {
        // Restore original value
        process.env.QWEN_DISCOVERY_MODE = originalMode;
      }
    } catch (error: any) {
      log.error(`Traditional LLM failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        requires_approval: false
      };
    }
  }

  /**
   * Try Qwen interactive editing session
   */
  private async tryQwenInteractive(
    request: PatchRequest,
    context: {
      previousAttempts: PatchGenerationAttempt[];
      lastError?: string;
      validationErrors?: string[];
    },
    sessionOptions: {
      enableFormatting?: boolean;
      useFullWorkspace?: boolean;
      timeoutMs?: number;
    } = {}
  ): Promise<PatchResult> {
    const options: QwenInteractiveOptions = {
      repo: request.repo,
      pr: request.pr,
      commitSha: request.commit_sha,
      targetFile: request.file,
      startLine: request.start_line,
      endLine: request.end_line,
      reviewComment: request.content,
      suggestions: request.suggestions?.map(s => s.code) || [],
      proposedFixes: request.proposed_fixes || [],
      agentPrompt: request.agent_prompt,
      gitOps: this.gitOps,
      maxRounds: 3,
      timeoutMs: sessionOptions.timeoutMs || 180000,
      enableFormatting: sessionOptions.enableFormatting ?? true,
      useFullWorkspace: sessionOptions.useFullWorkspace ?? true
    };

    // Build enhanced prompt with previous attempts for learning
    if (context.previousAttempts.length > 0) {
      const failureContext = context.previousAttempts.map((attempt, i) => 
        `### Attempt ${i + 1} (${attempt.method})\n` +
        (attempt.patch ? `**Patch**: \`\`\`diff\n${attempt.patch}\n\`\`\`\n\n` : '') +
        (attempt.error || attempt.validationError ? `**Error**: ${attempt.error || attempt.validationError}\n` : '')
      ).join('\n');

      options.agentPrompt = `${options.agentPrompt || ''}\n\n## Previous Failed Attempts (learn from these)\n${failureContext}\n\n**Important**: Avoid making the same mistakes. Ensure your patch applies cleanly.`;
    }

    const session = new QwenInteractiveSession(options);
    const result = await session.execute();

    if (result.success) {
      log.detail(`Qwen interactive succeeded (${result.patch?.length || 0} chars)`);
      if (result.thinking) {
        log.detail(`Thinking: ${result.thinking.substring(0, 300)}...`);
      }
    } else {
      log.warn(`Qwen interactive failed: ${result.error}`);
      if (result.validationErrors && result.validationErrors.length > 0) {
        log.detail(`Validation errors: ${result.validationErrors.join('; ')}`);
      }
    }

    return {
      success: result.success,
      patch: result.patch,
      error: result.error,
      requires_approval: false
    };
  }

  /**
   * Repair a failed patch
   */
  private async repairPatch(
    request: PatchRequest,
    patch: string,
    validationErrors: string[]
  ): Promise<string | null> {
    log.detail(`Attempting to repair patch with ${validationErrors.length} error(s)`);

    // Analyze the validation errors
    const analysis = this.errorAnalyzer.analyzeGitError(
      validationErrors.join('\n'),
      patch,
      '' // Would need file content here
    );

    log.detail(`Error analysis: ${analysis.errorType} - ${analysis.suggestions.join(', ')}`);

    // Try common repairs based on error type
    let repairedPatch = patch;

    switch (analysis.errorType) {
      case 'whitespace':
        repairedPatch = this.repairWhitespace(patch);
        break;
      case 'hunk_header':
        repairedPatch = this.repairHunkHeader(patch);
        break;
      case 'line_mismatch':
      case 'context_mismatch':
        repairedPatch = await this.repairContextLines(request, patch, analysis);
        break;
    }

    if (repairedPatch !== patch) {
      log.detail('Patch was modified during repair');
      return repairedPatch;
    }

    return null;
  }

  /**
   * Repair whitespace issues in patch
   */
  private repairWhitespace(patch: string): string {
    // Remove trailing whitespace from all lines
    return patch.split('\n').map(line => line.trimEnd()).join('\n');
  }

  /**
   * Repair hunk header issues
   */
  private repairHunkHeader(patch: string): string {
    const lines = patch.split('\n');
    const repairedLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('@@')) {
        // Ensure proper hunk header format
        const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (match) {
          const [, oldStart, oldCount = '1', newStart, newCount = '1'] = match;
          repairedLines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
        } else {
          repairedLines.push(line);
        }
      } else {
        repairedLines.push(line);
      }
    }

    return repairedLines.join('\n');
  }

  /**
   * Repair context lines by fetching actual file content
   */
  private async repairContextLines(
    request: PatchRequest,
    patch: string,
    analysis: PatchErrorAnalysis
  ): Promise<string | null> {
    try {
      // Fetch the actual file content
      const fileContent = await this.fetchFileContent(request);
      if (!fileContent) {
        log.warn('Could not fetch file content for context repair');
        return null;
      }

      const fileLines = fileContent.split('\n');

      // Parse the patch to find the hunk
      const hunks = this.errorAnalyzer.parseUnifiedDiff(patch);
      if (hunks.hunks.length === 0) {
        log.warn('No hunks found in patch');
        return null;
      }

      const hunk = hunks.hunks[0];
      const headerMatch = hunk.header.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      if (!headerMatch) {
        log.warn('Could not parse hunk header');
        return null;
      }

      const oldStart = parseInt(headerMatch[1], 10);
      const oldCount = parseInt(headerMatch[2] || '1', 10);

      // Get the actual file lines at the target location
      const contextStart = Math.max(0, oldStart - 4);
      const contextEnd = Math.min(fileLines.length, oldStart + oldCount + 3);
      const actualContext = fileLines.slice(contextStart, contextEnd);

      log.detail(`Actual file context (lines ${contextStart + 1}-${contextEnd}):`);
      log.detail(actualContext.join('\n'));

      // Rebuild the patch with correct context
      return this.rebuildPatchWithContext(request, patch, actualContext, contextStart + 1);

    } catch (error: any) {
      log.error(`Context repair failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Rebuild patch with correct context from actual file
   */
  private rebuildPatchWithContext(
    request: PatchRequest,
    originalPatch: string,
    actualContext: string[],
    newStartLine: number
  ): string | null {
    // Extract the changed lines from original patch
    const changedLines: string[] = [];
    const patchLines = originalPatch.split('\n');

    for (const line of patchLines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        changedLines.push(line.substring(1));
      }
    }

    if (changedLines.length === 0) {
      log.warn('No changed lines found in patch');
      return null;
    }

    // Build new patch with correct context
    let patch = `--- a/${request.file}\n`;
    patch += `+++ b/${request.file}\n`;

    const contextBefore = Math.min(3, newStartLine - 1);
    const contextAfter = Math.min(3, actualContext.length - changedLines.length);

    const oldStart = newStartLine - contextBefore;
    const oldCount = contextBefore + (actualContext.length - actualContext.length) + contextAfter;
    const newCount = contextBefore + changedLines.length + contextAfter;

    patch += `@@ -${oldStart},${oldCount} +${oldStart},${newCount} @@\n`;

    // Add context before
    for (let i = contextBefore; i > 0; i--) {
      if (actualContext[contextBefore - i]) {
        patch += ` ${actualContext[contextBefore - i]}\n`;
      }
    }

    // Add changed lines
    for (const line of changedLines) {
      patch += `+${line}\n`;
    }

    // Add context after
    for (let i = 0; i < contextAfter && i < actualContext.length; i++) {
      const idx = actualContext.length - contextAfter + i;
      if (actualContext[idx]) {
        patch += ` ${actualContext[idx]}\n`;
      }
    }

    return patch;
  }

  /**
   * Fetch file content from repository
   */
  private async fetchFileContent(request: PatchRequest): Promise<string | null> {
    try {
      const [owner, repo] = request.repo.split('/');

      // Use Octokit to fetch file content
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

      const response = await octokit.repos.getContent({
        owner,
        repo,
        path: request.file,
        ref: request.commit_sha
      });

      if (!('content' in response.data)) {
        return null;
      }

      // Decode base64 content
      const content = Buffer.from(response.data.content, 'base64').toString('utf8');
      return content;
    } catch (error: any) {
      log.error(`Failed to fetch file content: ${error.message}`);
      return null;
    }
  }

  /**
   * Validate a patch using git apply --check
   */
  private async validatePatchWithGit(
    request: PatchRequest,
    patch: string
  ): Promise<boolean> {
    if (!patch || patch.trim().length === 0) {
      return false;
    }

    const patchFile = path.join(this.tempDir, `validate-${Date.now()}.patch`);
    fs.writeFileSync(patchFile, patch);

    try {
      // Clone and checkout if needed
      await this.gitOps.clone(request.repo);
      await this.gitOps.checkout(request.repo, request.commit_sha);

      try {
        execSync(`git apply --check "${patchFile}"`, {
          cwd: this.gitOps.getRepoDir(request.repo),
          stdio: 'pipe',
          timeout: 10000
        });
        return true;
      } catch (error: any) {
        const errorOutput = error.stderr?.toString() || error.stdout?.toString() || error.message;
        log.detail(`Git apply error: ${errorOutput.substring(0, 300)}`);
        return false;
      }
    } catch (error: any) {
      log.warn(`Validation setup failed: ${error.message}`);
      return false;
    } finally {
      if (fs.existsSync(patchFile)) {
        fs.unlinkSync(patchFile);
      }
    }
  }

  /**
   * Validate a patch using git apply --check (legacy method)
   * @deprecated Use validatePatchWithGit instead
   */
  private async validatePatch(
    request: PatchRequest,
    patch: string
  ): Promise<{ valid: boolean; error?: string; warnings: string[] }> {
    const warnings: string[] = [];

    if (!patch || patch.trim().length === 0) {
      return { valid: false, error: 'Empty patch', warnings };
    }

    const patchFile = path.join(this.tempDir, `validate-${Date.now()}.patch`);
    fs.writeFileSync(patchFile, patch);

    try {
      // Clone and checkout if needed
      await this.gitOps.clone(request.repo);
      await this.gitOps.checkout(request.repo, request.commit_sha);

      try {
        execSync(`git apply --check "${patchFile}"`, {
          cwd: this.gitOps.getRepoDir(request.repo),
          stdio: 'pipe',
          timeout: 10000
        });
        return { valid: true, warnings };
      } catch (error: any) {
        const errorOutput = error.stderr?.toString() || error.stdout?.toString() || error.message;
        return {
          valid: false,
          error: errorOutput,
          warnings
        };
      }
    } catch (error: any) {
      return {
        valid: false,
        error: `Validation setup failed: ${error.message}`,
        warnings
      };
    } finally {
      if (fs.existsSync(patchFile)) {
        fs.unlinkSync(patchFile);
      }
    }
  }

  /**
   * Enhance request with feedback from previous attempts
   */
  private enhanceRequestWithFeedback(
    request: PatchRequest,
    context: {
      previousAttempts: PatchGenerationAttempt[];
      lastError?: string;
      validationErrors?: string[];
    }
  ): PatchRequest {
    let enhancedContent = request.content;

    if (context.previousAttempts.length > 0) {
      enhancedContent += '\n\n## Previous Failed Attempts\n';

      context.previousAttempts.forEach((attempt, i) => {
        enhancedContent += `\n### Attempt ${i + 1} (${attempt.method})\n`;
        if (attempt.patch) {
          enhancedContent += `**Generated Patch**:\n\`\`\`diff\n${attempt.patch}\n\`\`\`\n\n`;
        }
        if (attempt.validationError || attempt.error) {
          enhancedContent += `**Error**: ${attempt.validationError || attempt.error}\n`;
        }
      });

      enhancedContent += '\n**Important**: Learn from these mistakes and generate a DIFFERENT patch that avoids these errors.\n';
    }

    if (context.validationErrors && context.validationErrors.length > 0) {
      enhancedContent += `\n\n**Validation Issues to Fix**:\n- ${context.validationErrors.join('\n- ')}\n`;
    }

    return {
      ...request,
      content: enhancedContent
    };
  }

  /**
   * Record an attempt in history
   */
  private recordAttempt(attempt: PatchGenerationAttempt): void {
    this.attemptHistory.push(attempt);
    log.detail(`Recorded attempt: Round ${attempt.round}, Method: ${attempt.method}, Success: ${!!attempt.patch}`);
  }

  /**
   * Cleanup temporary files
   */
  cleanup(): void {
    try {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    } catch (error) {
      log.warn('Failed to cleanup temp directory');
    }
  }
}
