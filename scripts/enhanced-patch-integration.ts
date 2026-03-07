/**
 * Enhanced Patch Generation Integration
 * 
 * This module integrates the new iterative patch generator, enhanced logging,
 * and persistent state management into the existing agent workflow.
 * 
 * Usage: Import and use in agent.ts to replace/augment existing patch generation
 */

import { PatchGenerator } from './patch-generator';
import { IterativePatchGenerator } from './iterative-patch-generator';
import { GitOps } from './git-ops';
import { PatchRequest, PatchResult } from './types';
import { PersistentPatchStateManager } from './persistent-patch-state';
import { createSessionLogger, EnhancedLogger } from './enhanced-logging';
import { PatchErrorAnalyzer } from './patch-error-analyzer';

export interface EnhancedPatchGenerationOptions {
  useIterativeGenerator: boolean;
  useQwenFullFile: boolean;
  maxRounds: number;
  maxLlmRetries: number;
  timeoutPerRound: number;
  enableEnhancedLogging: boolean;
  enablePersistentState: boolean;
  logDir: string;
}

const DEFAULT_OPTIONS: EnhancedPatchGenerationOptions = {
  useIterativeGenerator: true,
  useQwenFullFile: true,
  maxRounds: 5,
  maxLlmRetries: 2,
  timeoutPerRound: 120000,
  enableEnhancedLogging: true,
  enablePersistentState: true,
  logDir: './logs/pr-autopilot'
};

export class EnhancedPatchIntegration {
  private iterativeGenerator: IterativePatchGenerator;
  private traditionalGenerator: PatchGenerator;
  private stateManager: PersistentPatchStateManager | null;
  private logger: EnhancedLogger | null;
  private errorAnalyzer: PatchErrorAnalyzer;
  private options: EnhancedPatchGenerationOptions;

  constructor(
    gitOps: GitOps,
    options: Partial<EnhancedPatchGenerationOptions> = {}
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    
    this.iterativeGenerator = new IterativePatchGenerator(gitOps);
    this.traditionalGenerator = new PatchGenerator();
    this.errorAnalyzer = new PatchErrorAnalyzer();
    
    // Initialize state manager if enabled
    if (this.options.enablePersistentState) {
      this.stateManager = new PersistentPatchStateManager();
    } else {
      this.stateManager = null;
    }
    
    // Initialize logger if enabled
    if (this.options.enableEnhancedLogging) {
      this.logger = createSessionLogger({
        logDir: this.options.logDir,
        captureThinking: true,
        saveToFile: true
      });
    } else {
      this.logger = null;
    }
  }

  /**
   * Generate patch with enhanced features
   */
  async generatePatch(
    request: PatchRequest,
    level: number = 2,
    commentId?: string
  ): Promise<PatchResult> {
    const sessionId = `${request.repo}-${request.pr}-${commentId || Date.now()}`;
    
    // Initialize logger for this session
    if (this.logger) {
      this.logger.info('PATCH_GEN', 'Starting patch generation', {
        repo: request.repo,
        pr: request.pr,
        file: request.file,
        level
      });
    }

    // Create persistent state if enabled
    let stateId: string | undefined;
    if (this.stateManager) {
      const state = this.stateManager.createPatchState(
        request.repo,
        request.pr,
        request.file,
        request.start_line,
        request.end_line,
        commentId || 'unknown',
        { level, sessionId }
      );
      stateId = state.id;
      
      this.stateManager.updatePatchStatus(stateId, 'GENERATING');
    }

    const startTime = Date.now();

    try {
      let result: PatchResult;

      if (this.options.useIterativeGenerator) {
        // Use new iterative generator with retry logic
        result = await this.generateWithIterative(request, level, stateId);
      } else {
        // Fall back to traditional generator
        result = await this.generateWithTraditional(request, level, stateId);
      }

      const duration = Date.now() - startTime;

      // Log result
      if (this.logger) {
        this.logger.logPatchAttempt(
          request.repo,
          request.pr,
          request.file,
          1,
          this.options.useIterativeGenerator ? 'iterative' : 'traditional',
          result.success,
          result.error,
          result.patch
        );
      }

      // Update state
      if (this.stateManager && stateId) {
        if (result.success) {
          this.stateManager.updatePatchStatus(stateId, 'GENERATED', result.patch);
          this.stateManager.addPatchAttempt(stateId, 'success', result.patch, undefined, undefined, 0, duration);
        } else {
          this.stateManager.updatePatchStatus(stateId, 'FAILED', undefined, result.error);
          this.stateManager.addPatchAttempt(stateId, 'failed', undefined, result.error, undefined, 0, duration);
        }
      }

      return result;

    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      // Log error
      if (this.logger) {
        this.logger.error('PATCH_GEN', 'Patch generation failed with exception', {
          error: errorMsg,
          stack: error?.stack
        });
      }

      // Update state
      if (this.stateManager && stateId) {
        this.stateManager.updatePatchStatus(stateId, 'FAILED', undefined, errorMsg);
        this.stateManager.addPatchAttempt(stateId, 'error', undefined, errorMsg, undefined, 0, duration);
      }

      return {
        success: false,
        error: errorMsg,
        requires_approval: false
      };
    }
  }

  /**
   * Generate patch using iterative generator
   */
  private async generateWithIterative(
    request: PatchRequest,
    level: number,
    stateId?: string
  ): Promise<PatchResult> {
    const result = await this.iterativeGenerator.generatePatchIterative(
      request,
      level,
      {
        maxRounds: this.options.maxRounds,
        maxLlmRetries: this.options.maxLlmRetries,
        useQwenFullFile: this.options.useQwenFullFile,
        timeoutPerRound: this.options.timeoutPerRound
      }
    );

    // Capture thinking logs if available
    if (this.logger && 'thinkingLog' in this.iterativeGenerator) {
      // Note: Would need to expose thinking log from generator
    }

    return result;
  }

  /**
   * Generate patch using traditional generator
   */
  private async generateWithTraditional(
    request: PatchRequest,
    level: number,
    stateId?: string
  ): Promise<PatchResult> {
    return await this.traditionalGenerator.generatePatch(request, level, false);
  }

  /**
   * Validate patch with enhanced error analysis
   */
  async validatePatch(
    request: PatchRequest,
    patch: string,
    fileContent?: string
  ): Promise<{
    valid: boolean;
    error?: string;
    visualDiff?: string;
    suggestions?: string[];
  }> {
    // Basic validation using git apply --check
    const isValid = await this.validateWithGit(request, patch);

    if (isValid) {
      return { valid: true };
    }

    // Enhanced error analysis if validation failed
    if (fileContent && this.logger) {
      const analysis = this.errorAnalyzer.analyzeGitError('', patch, fileContent);
      const highlight = this.errorAnalyzer.generateDiffHighlight(patch, fileContent, request.file);

      // Log visual diff
      this.logger.logValidationError(
        request.repo,
        request.pr,
        request.file,
        patch,
        analysis.rawError,
        highlight.visualDiff
      );

      return {
        valid: false,
        error: analysis.rawError,
        visualDiff: highlight.visualDiff,
        suggestions: analysis.suggestions
      };
    }

    return { valid: false, error: 'Patch validation failed' };
  }

  /**
   * Validate patch using git apply --check
   */
  private async validateWithGit(
    request: PatchRequest,
    patch: string
  ): Promise<boolean> {
    const { execSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-validate-'));
    const patchFile = path.join(tempDir, 'test.patch');

    try {
      fs.writeFileSync(patchFile, patch);

      // Clone and checkout
      await this.iterativeGenerator['gitOps'].clone(request.repo);
      await this.iterativeGenerator['gitOps'].checkout(request.repo, request.commit_sha);

      const repoDir = this.iterativeGenerator['gitOps'].getRepoDir(request.repo);

      try {
        execSync(`git apply --check "${patchFile}"`, {
          cwd: repoDir,
          stdio: 'pipe',
          timeout: 10000
        });
        return true;
      } catch {
        return false;
      }
    } catch (error) {
      return false;
    } finally {
      try {
        if (fs.existsSync(patchFile)) {
          fs.unlinkSync(patchFile);
        }
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      } catch (cleanupError) {
        if (this.logger) {
          this.logger.error('CLEANUP', 'Failed to clean up temp files', {
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          });
        }
      }
    }
  }

  /**
   * Get recovery report for pending work
   */
  getRecoveryReport(): string {
    if (!this.stateManager) {
      return 'Persistent state management is disabled';
    }

    const recovery = this.stateManager.recoverPendingWork();
    return recovery.recoveryReport || 'No pending work found';
  }

  /**
   * Retry failed patches
   */
  async retryFailedPatches(repo?: string, pr?: number): Promise<number> {
    if (!this.stateManager) {
      return 0;
    }

    const failed = this.stateManager.getFailedPatches(repo, pr);
    const retried = this.stateManager.retryFailedPatches(repo, pr);

    if (this.logger) {
      this.logger.info('RETRY', `Retrying ${retried.length} failed patches`, {
        repo,
        pr,
        total: failed.length,
        retried: retried.length
      });
    }

    return retried.length;
  }

  /**
   * Export session report
   */
  exportSessionReport(): string {
    if (!this.logger) {
      return 'Enhanced logging is disabled';
    }

    return this.logger.exportSessionReport();
  }

  /**
   * Save session report to file
   */
  saveSessionReport(): string {
    if (!this.logger) {
      return '';
    }

    return this.logger.saveSessionReport();
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.iterativeGenerator.cleanup();
    this.traditionalGenerator.cleanup();
    
    if (this.logger) {
      this.saveSessionReport();
    }
  }
}

/**
 * Factory function to create enhanced patch integration
 */
export function createEnhancedPatchIntegration(
  gitOps: GitOps,
  options?: Partial<EnhancedPatchGenerationOptions>
): EnhancedPatchIntegration {
  return new EnhancedPatchIntegration(gitOps, options);
}
