import { PatchRequest, PatchResult } from './types';
import { EnhancedQwenSession, EnhancedQwenOptions, EnhancedQwenResult } from './enhanced-qwen-session';
import { GitOps } from './git-ops';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const log = {
  header: (msg: string) => console.log(`\n\x1b[1;38;5;208m[ROBUST-PATCH] ══ ${msg} ══\x1b[0m`),
  step: (msg: string) => console.log(`\x1b[32m[STEP]\x1b[0m ${msg}`),
  detail: (msg: string) => console.log(`\x1b[2m[DETAIL]\x1b[0m ${msg}`),
  warn: (msg: string) => console.log(`\x1b[1;33m[WARN]\x1b[0m ${msg}`),
  error: (msg: string) => console.log(`\x1b[1;31m[ERROR]\x1b[0m ${msg}`),
  success: (msg: string) => console.log(`\x1b[1;32m[SUCCESS]\x1b[0m ${msg}`),
  diff: (msg: string) => console.log(`\x1b[38;5;245m[DIFF]\x1b[0m ${msg}`),
  validation: (msg: string) => console.log(`\x1b[38;5;51m[VALIDATION]\x1b[0m ${msg}`),
  repair: (msg: string) => console.log(`\x1b[38;5;208m[REPAIR]\x1b[0m ${msg}`),
};

interface PatchAttempt {
  patch: string;
  error: string;
  llm: string;
  timestamp: number;
  validationDetails?: any;
}

interface ValidationReport {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  appliedFiles: string[];
  failedFiles: Array<{ file: string; error: string }>;
  repairAttempts: number;
  finalPatch?: string;
}

export class RobustPatchGenerator {
  private tempDir: string;
  private attemptHistory: Map<string, PatchAttempt[]> = new Map();

  constructor(private gitOps: GitOps) {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robust-patch-'));
  }

  async generateRobustPatch(
    request: PatchRequest,
    level: number = 2,
    useCliTools: boolean = true
  ): Promise<PatchResult> {
    log.header(`Generating robust patch for ${request.file}`);
    log.step(`Level: ${level}, CLI Tools: ${useCliTools}`);
    
    const requestId = `${request.repo}-${request.pr}-${request.file}-${request.start_line}-${request.end_line}`;
    // FIX: Initialize attempt history in map to avoid stale state within same run
    const previousAttempts = this.attemptHistory.get(requestId) || [];
    if (!this.attemptHistory.has(requestId)) {
      this.attemptHistory.set(requestId, previousAttempts);
    }

    try {
      // Step 1: Try mechanical extraction first
      const mechanicalResult = await this.tryMechanicalExtraction(request);
      if (mechanicalResult.success) {
        log.success('Mechanical extraction succeeded');
        return mechanicalResult;
      }

      // Step 2: Try traditional LLM approach
      const traditionalResult = await this.tryTraditionalLLM(request, level, previousAttempts);
      if (traditionalResult.success) {
        log.success('Traditional LLM approach succeeded');
        return traditionalResult;
      }

      // Step 3: Use Enhanced Qwen CLI session
      if (useCliTools) {
        const enhancedResult = await this.tryEnhancedQwen(request, previousAttempts);
        if (enhancedResult.success) {
          log.success('Enhanced Qwen CLI approach succeeded');
          return this.convertToPatchResult(enhancedResult);
        }
      }

      // Step 4: Final repair attempt
      const repairResult = await this.tryFinalRepair(request, previousAttempts);
      if (repairResult.success) {
        log.success('Final repair attempt succeeded');
        return repairResult;
      }

      // All attempts failed
      return { success: false, error: `All patch generation methods failed. Attempts: ${previousAttempts.length + 1}`, requires_approval: false };

    } finally {
      this.cleanup();
    }
  }

  private async tryMechanicalExtraction(request: PatchRequest): Promise<PatchResult> {
    log.step('Trying mechanical extraction');

    // Extract suggestions from content
    const suggestions: string[] = this.extractSuggestions(request.content);
    
    // Also check request.suggestions if available (array of ExtractedSuggestion objects)
    if (request.suggestions && Array.isArray(request.suggestions)) {
      for (const suggestion of request.suggestions) {
        if (suggestion.code && !suggestions.includes(suggestion.code)) {
          suggestions.push(suggestion.code);
        }
      }
    }
    
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      log.detail('No mechanical suggestions found');
      return { success: false, error: 'No mechanical suggestions found', requires_approval: false };
    }

    // Try each suggestion
    for (const suggestion of suggestions) {
      const patch = this.createMechanicalPatch(request, suggestion);
      const validation = await this.validatePatch(request, patch);

      if (validation.isValid) {
        log.success('Mechanical patch validation passed');
        return { success: true, patch, requires_approval: false };
      } else {
        log.warn(`Mechanical patch failed: ${validation.errors.join(', ')}`);
      }
    }

    return { success: false, error: 'All mechanical suggestions failed validation', requires_approval: false };
  }

  private async tryTraditionalLLM(
    request: PatchRequest,
    level: number,
    previousAttempts: PatchAttempt[]
  ): Promise<PatchResult> {
    log.step('Trying traditional LLM approach');
    
    // Use existing PatchGenerator logic but with enhanced error handling
    const { PatchGenerator } = await import('./patch-generator');
    const traditionalGenerator = new PatchGenerator();
    
    // Enhance prompt with previous attempt information
    const enhancedRequest = this.enhanceRequestWithHistory(request, previousAttempts);
    
    try {
      const result = await traditionalGenerator.generatePatch(enhancedRequest, level, false);
      
      if (result.success && result.patch) {
        const validation = await this.validatePatch(request, result.patch);
        
        if (validation.isValid) {
          log.success('Traditional LLM patch validation passed');
          return result;
        } else {
          // Try to repair the patch
          const repairedPatch = await this.repairPatch(request, result.patch, validation.errors);
          if (repairedPatch) {
            const repairValidation = await this.validatePatch(request, repairedPatch);
            if (repairValidation.isValid) {
              log.success('Traditional LLM patch repair succeeded');
              return { success: true, patch: repairedPatch, requires_approval: false };
            }
          }
          
          // Record failed attempt
          this.recordAttempt(request, result.patch || '', validation.errors.join('; '), 'traditional');
        }
      }
    } catch (error: any) {
      log.error(`Traditional LLM failed: ${error.message}`);
      this.recordAttempt(request, '', error.message, 'traditional');
    }

    return { success: false, error: 'Traditional LLM approach failed', requires_approval: false };
  }

  private async tryEnhancedQwen(
    request: PatchRequest,
    previousAttempts: PatchAttempt[]
  ): Promise<EnhancedQwenResult> {
    log.step('Trying Enhanced Qwen CLI session');
    
    const options: EnhancedQwenOptions = {
      repo: request.repo,
      pr: request.pr,
      commitSha: request.commit_sha,
      targetFile: request.file,
      startLine: request.start_line,
      endLine: request.end_line,
      reviewComment: request.content,
      previousAttempts,
      suggestedFixes: request.suggestions || [],
      committableSuggestions: request.proposed_fixes || [],
      gitOps: this.gitOps
    };

    const session = new EnhancedQwenSession(options);
    return await session.execute();
  }

  private async tryFinalRepair(
    request: PatchRequest,
    previousAttempts: PatchAttempt[]
  ): Promise<PatchResult> {
    log.step('Trying final repair attempt');
    
    // Get the best previous attempt and try to repair it
    const bestAttempt = this.findBestAttempt(previousAttempts);
    if (!bestAttempt) {
      return { success: false, error: 'No previous attempts to repair', requires_approval: false };
    }

    const repairedPatch = await this.advancedRepair(request, bestAttempt.patch, bestAttempt.error);
    if (repairedPatch) {
      const validation = await this.validatePatch(request, repairedPatch);
      if (validation.isValid) {
        log.success('Final repair succeeded');
        return { success: true, patch: repairedPatch, requires_approval: false };
      }
    }

    return { success: false, error: 'Final repair attempt failed', requires_approval: false };
  }

  private extractSuggestions(content: string): string[] {
    const suggestions: string[] = [];
    
    // Extract ```suggestion blocks
    const suggestionMatches = content.match(/```suggestion\n([\s\S]*?)\n```/gi);
    if (suggestionMatches) {
      suggestions.push(...suggestionMatches.map(match => 
        match.replace(/```suggestion\n?|```$/gi, '').trim()
      ));
    }
    
    // Extract ```diff blocks
    const diffMatches = content.match(/```diff\n([\s\S]*?)\n```/gi);
    if (diffMatches) {
      suggestions.push(...diffMatches.map(match => 
        match.replace(/```diff\n?|```$/gi, '').trim()
      ));
    }
    
    return suggestions;
  }

  private createMechanicalPatch(request: PatchRequest, suggestion: string): string {
    // Create a simple mechanical patch
    return `--- a/${request.file}\n+++ b/${request.file}\n@@ -${request.start_line},${request.end_line - request.start_line + 1} +${request.start_line},${request.end_line - request.start_line + 1} @@\n${suggestion}`;
  }

  private async validatePatch(request: PatchRequest, patch: string): Promise<ValidationReport> {
    log.validation(`Validating patch for ${request.file}`);
    
    const report: ValidationReport = {
      isValid: false,
      errors: [],
      warnings: [],
      appliedFiles: [],
      failedFiles: [],
      repairAttempts: 0
    };

    if (!patch || patch.trim().length === 0) {
      report.errors.push('Empty patch');
      return report;
    }

    // Ensure temp directory exists (may have been cleaned up from previous run)
    if (!fs.existsSync(this.tempDir)) {
      this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robust-patch-'));
    }

    // Write patch to temporary file
    const patchFile = path.join(this.tempDir, `validation-${Date.now()}.patch`);
    fs.writeFileSync(patchFile, patch);

    try {
      // Clone repo and checkout specific commit
      await this.gitOps.clone(request.repo);
      await this.gitOps.checkout(request.repo, request.commit_sha);

      // Try git apply --check first
      try {
        execSync(`git apply --check "${patchFile}"`, {
          cwd: this.gitOps.getRepoDir(request.repo),
          stdio: 'pipe'
        });
        report.isValid = true;
        report.appliedFiles.push(request.file);
        log.validation('Patch validation passed');
      } catch (error: any) {
        const errorOutput = error.stdout?.toString() || error.stderr?.toString() || error.message;
        report.errors.push(`Git apply failed: ${errorOutput}`);
        log.validation(`Patch validation failed: ${errorOutput}`);
      }

    } catch (error: any) {
      report.errors.push(`Validation setup failed: ${error.message}`);
    } finally {
      // Cleanup
      try {
        fs.unlinkSync(patchFile);
      } catch {}
    }

    return report;
  }

  private async repairPatch(
    request: PatchRequest,
    patch: string,
    errors: string[]
  ): Promise<string | null> {
    log.repair(`Attempting to repair patch with ${errors.length} errors`);
    
    let repairedPatch = patch;

    // Common repair strategies
    for (const error of errors) {
      if (error.includes('No such file or directory')) {
        // Try to fix file paths
        repairedPatch = this.repairFilePaths(repairedPatch);
      } else if (error.includes('corrupt patch at line')) {
        // Try to fix patch structure
        repairedPatch = this.repairPatchStructure(repairedPatch);
      } else if (error.includes('patch does not apply')) {
        // Try to fix context lines
        repairedPatch = this.repairContextLines(repairedPatch);
      }
    }

    // Validate the repaired patch
    const validation = await this.validatePatch(request, repairedPatch);
    if (validation.isValid) {
      log.success('Patch repair succeeded');
      return repairedPatch;
    }

    return null;
  }

  private async advancedRepair(
    request: PatchRequest,
    patch: string,
    error: string
  ): Promise<string | null> {
    log.repair('Attempting advanced patch repair');
    
    // Try more sophisticated repair strategies
    const repairs = [
      () => this.repairWithFuzzyMatching(request, patch),
      () => this.repairWithLineAdjustment(request, patch),
      () => this.repairWithContentReconstruction(request, patch)
    ];

    for (const repairFn of repairs) {
      try {
        const repairedPatch = await repairFn();
        if (repairedPatch) {
          const validation = await this.validatePatch(request, repairedPatch);
          if (validation.isValid) {
            log.success('Advanced repair succeeded');
            return repairedPatch;
          }
        }
      } catch (error) {
        log.detail(`Repair attempt failed: ${error}`);
      }
    }

    return null;
  }

  private repairFilePaths(patch: string): string {
    // FIX: Actually repair common file path issues instead of no-op replacements
    return patch
      // Remove any leading/trailing whitespace from file paths
      .replace(/^--- a\/\s+/gm, '--- a/')
      .replace(/^\+\+\+ b\/\s+/gm, '+++ b/')
      // Fix missing 'a/' or 'b/' prefix
      .replace(/^--- ([^a\/])/gm, '--- a/$1')
      .replace(/^\+\+\+ ([^b\/])/gm, '+++ b/$1')
      // Fix double slashes in paths
      .replace(/^--- a\/\//gm, '--- a/')
      .replace(/^\+\+\+ b\/\//gm, '+++ b/')
      // Normalize backslashes to forward slashes (Windows paths)
      .replace(/^--- a\/(.*)\\(.*)$/gm, '--- a/$1/$2')
      .replace(/^\+\+\+ b\/(.*)\\(.*)$/gm, '+++ b/$1/$2');
  }

  private repairPatchStructure(patch: string): string {
    // Fix patch structure issues
    const lines = patch.split('\n');
    const repairedLines: string[] = [];
    
    for (const line of lines) {
      if (line.startsWith('@@') && !line.includes(' @@')) {
        // Fix hunk header
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

  private repairContextLines(patch: string): string {
    // Try to fix context line issues
    // This is a simplified implementation
    return patch;
  }

  private async repairWithFuzzyMatching(request: PatchRequest, patch: string): Promise<string | null> {
    // Implement fuzzy matching for patch application
    // This is a placeholder for a more sophisticated implementation
    return null;
  }

  private async repairWithLineAdjustment(request: PatchRequest, patch: string): Promise<string | null> {
    // Try adjusting line numbers in the patch
    // This is a placeholder for a more sophisticated implementation
    return null;
  }

  private async repairWithContentReconstruction(request: PatchRequest, patch: string): Promise<string | null> {
    // Try to reconstruct the patch based on the intent
    // This is a placeholder for a more sophisticated implementation
    return null;
  }

  private enhanceRequestWithHistory(request: PatchRequest, attempts: PatchAttempt[]): PatchRequest {
    if (attempts.length === 0) return request;

    const historyText = attempts.map((attempt, i) => `
Previous Attempt ${i + 1} (${attempt.llm}):
Error: ${attempt.error}
Patch:
\`\`\`diff
${attempt.patch}
\`\`\`
`).join('\n');

    const enhancedContent = `${request.content}

${historyText}

Please learn from these previous attempts and avoid making the same mistakes.
`;

    return {
      ...request,
      content: enhancedContent
    };
  }

  private recordAttempt(request: PatchRequest, patch: string, error: string, llm: string): void {
    const requestId = `${request.repo}-${request.pr}-${request.file}-${request.start_line}-${request.end_line}`;
    const attempts = this.attemptHistory.get(requestId) || [];
    
    attempts.push({
      patch,
      error,
      llm,
      timestamp: Date.now()
    });

    this.attemptHistory.set(requestId, attempts);
  }

  private findBestAttempt(attempts: PatchAttempt[]): PatchAttempt | null {
    if (attempts.length === 0) return null;

    // Find the attempt with the most substantial patch (closest to success)
    return attempts.reduce((best, current) => {
      if (current.patch.length > best.patch.length) {
        return current;
      }
      return best;
    });
  }

  private convertToPatchResult(result: EnhancedQwenResult): PatchResult {
    return {
      success: result.success,
      patch: result.patch,
      error: result.error,
      requires_approval: false
    };
  }

  private cleanup(): void {
    try {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    } catch (error) {
      log.warn('Failed to cleanup temporary directory');
    }
  }
}
