import { PatchRequest, PatchResult, ParsedReviewComment, PRConfig } from './types';
import { RobustPatchGenerator } from './robust-patch-generator';
import { EnhancedLogger, DiffAnalysis } from './enhanced-logging';
import { PersistentPatchStateManager, PatchState } from './persistent-patch-state';
import { GitOps } from './git-ops';

/**
 * Enhanced Agent Integration
 * 
 * This module provides the integration layer for using the enhanced patch generation
 * system with the existing PR Autopilot agent architecture.
 */

export interface EnhancedAgentConfig {
  enableRobustPatching: boolean;
  enableEnhancedQwen: boolean;
  enablePersistentState: boolean;
  enableEnhancedLogging: boolean;
  maxRetries: number;
  timeoutMs: number;
}

export class EnhancedAgentIntegration {
  private robustGenerator: RobustPatchGenerator;
  private stateManager: PersistentPatchStateManager;
  private logger: EnhancedLogger;
  private config: EnhancedAgentConfig;

  constructor(
    private gitOps: GitOps,
    config: Partial<EnhancedAgentConfig> = {}
  ) {
    this.config = {
      enableRobustPatching: true,
      enableEnhancedQwen: true,
      enablePersistentState: true,
      enableEnhancedLogging: true,
      maxRetries: 3,
      timeoutMs: 5 * 60 * 1000, // 5 minutes
      ...config
    };

    this.robustGenerator = new RobustPatchGenerator(gitOps);
    this.stateManager = new PersistentPatchStateManager();
    this.logger = new EnhancedLogger(`agent-${Date.now()}`);
  }

  /**
   * Process a single comment with enhanced capabilities
   */
  async processComment(
    request: PatchRequest,
    level: number,
    config: PRConfig,
    comment: ParsedReviewComment
  ): Promise<PatchResult> {
    const sessionId = `${request.repo}-${request.pr}-${comment.id}`;
    this.logger.info('COMMENT_PROCESSING', `Starting enhanced processing for ${comment.file}:${comment.start_line}`);

    let patchState: PatchState | undefined;

    try {
      // Create persistent state if enabled
      if (this.config.enablePersistentState) {
        patchState = this.stateManager.createPatchState(
          request.repo,
          request.pr,
          request.file,
          request.start_line,
          request.end_line,
          comment.id,
          { level, config, originalComment: comment }
        );

        this.stateManager.updatePatchStatus(patchState.id, 'GENERATING');
        this.logger.info('STATE_CREATED', `Created patch state: ${patchState.id}`);
      }

      // Process with timeout
      const result = await this.withTimeout(
        this.generatePatchWithRetry(request, level, config, comment, patchState),
        this.config.timeoutMs
      );

      // Update final state
      if (patchState) {
        if (result.success) {
          this.stateManager.updatePatchStatus(patchState.id, 'APPLIED', result.patch);
          this.logger.success('PATCH_APPLIED', `Successfully applied patch for ${comment.id}`);
        } else {
          this.stateManager.updatePatchStatus(patchState.id, 'FAILED', undefined, result.error);
          this.logger.error('PATCH_FAILED', `Failed to apply patch for ${comment.id}: ${result.error}`);
        }
      }

      return result;

    } catch (error: any) {
      const errorMessage = `Enhanced processing failed: ${error.message}`;
      this.logger.error('PROCESSING_ERROR', errorMessage);

      if (patchState) {
        this.stateManager.updatePatchStatus(patchState.id, 'FAILED', undefined, errorMessage);
      }

      return {
        success: false,
        error: errorMessage,
        requires_approval: false
      };
    }
  }

  /**
   * Process multiple comments in batch with enhanced coordination
   */
  async processBatch(
    requests: Array<{ request: PatchRequest; level: number; comment: ParsedReviewComment }>,
    config: PRConfig
  ): Promise<{
    results: PatchResult[];
    summary: {
      total: number;
      successful: number;
      failed: number;
      patchesGenerated: number;
    };
  }> {
    const batchId = `batch-${Date.now()}`;
    this.logger.info('BATCH_PROCESSING', `Starting batch processing for ${requests.length} comments`);

    const results: PatchResult[] = [];
    const patchIds: string[] = [];

    try {
      // Process all comments
      for (const { request, level, comment } of requests) {
        const result = await this.processComment(request, level, config, comment);
        results.push(result);

        if (result.success) {
          // Find the patch state ID for successful patches
          const patchId = this.findPatchStateId(request.repo, request.pr, comment.id);
          if (patchId) {
            patchIds.push(patchId);
          }
        }
      }

      // Create batch commit state if we have successful patches
      if (patchIds.length > 0 && this.config.enablePersistentState) {
        const batchState = this.stateManager.createBatchCommit(
          requests[0].request.repo,
          requests[0].request.pr,
          patchIds
        );

        this.stateManager.updateBatchStatus(batchState.id, 'READY');
        this.logger.info('BATCH_READY', `Batch ${batchId} ready with ${patchIds.length} patches`);
      }

      const summary = {
        total: requests.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        patchesGenerated: patchIds.length
      };

      this.logger.info('BATCH_COMPLETE', `Batch processing complete: ${JSON.stringify(summary)}`);

      return { results, summary };

    } catch (error: any) {
      this.logger.error('BATCH_ERROR', `Batch processing failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Recover and retry failed patches
   */
  async recoverFailedPatches(repo?: string, pr?: number): Promise<{
    recovered: number;
    results: PatchResult[];
  }> {
    if (!this.config.enablePersistentState) {
      throw new Error('Persistent state must be enabled for recovery');
    }

    this.logger.info('RECOVERY_START', `Starting recovery for ${repo || 'all repos'}, ${pr || 'all PRs'}`);

    const failedPatches = this.stateManager.getFailedPatches(repo, pr);
    const retried = this.stateManager.retryFailedPatches(repo, pr);
    
    const results: PatchResult[] = [];
    let recovered = 0;

    for (const patchState of retried) {
      try {
        // Reconstruct the original request from state
        const request = this.reconstructPatchRequest(patchState);
        const level = patchState.metadata?.level || 2;
        const config = patchState.metadata?.config || {};
        const comment = patchState.metadata?.originalComment;

        if (request && comment) {
          const result = await this.processComment(request, level, config, comment);
          results.push(result);
          
          if (result.success) {
            recovered++;
          }
        }
      } catch (error: any) {
        this.logger.error('RECOVERY_ERROR', `Failed to recover patch ${patchState.id}: ${error.message}`);
        results.push({
          success: false,
          error: error.message,
          requires_approval: false
        });
      }
    }

    this.logger.info('RECOVERY_COMPLETE', `Recovery complete: ${recovered}/${retried.length} patches recovered`);

    return { recovered, results };
  }

  /**
   * Get comprehensive status report
   */
  getStatusReport(): {
    summary: any;
    recentActivity: any;
    recommendations: string[];
  } {
    const report = this.stateManager.generateReport();
    const logSummary = this.logger.getSummary();

    const recommendations = this.generateRecommendations(report, logSummary);

    return {
      summary: report.summary,
      recentActivity: {
        patches: report.patches.slice(0, 10),
        batches: report.batches.slice(0, 5),
        logs: logSummary.errors.slice(0, 5)
      },
      recommendations
    };
  }

  /**
   * Export logs and state for analysis
   */
  exportAnalysis(): {
    logPath: string;
    stateReport: any;
  } {
    const logPath = this.logger.exportLogs();
    const stateReport = this.stateManager.generateReport();

    return { logPath, stateReport };
  }

  /**
   * Cleanup old states and logs
   */
  cleanup(maxAgeHours: number = 24): void {
    this.stateManager.cleanupOldStates(maxAgeHours);
    this.logger.info('CLEANUP', `Cleaned up states older than ${maxAgeHours} hours`);
  }

  // Private methods

  private async generatePatchWithRetry(
    request: PatchRequest,
    level: number,
    config: PRConfig,
    comment: ParsedReviewComment,
    patchState?: PatchState
  ): Promise<PatchResult> {
    let lastError: string = '';
    let attempts = 0;

    while (attempts < this.config.maxRetries) {
      attempts++;
      this.logger.info('PATCH_ATTEMPT', `Attempt ${attempts}/${this.config.maxRetries} for ${comment.id}`);

      try {
        const startTime = Date.now();
        
        // Use robust patch generator
        const result = await this.robustGenerator.generateRobustPatch(
          request,
          level,
          config.autofix.use_cli_tools && this.config.enableEnhancedQwen
        );

        const duration = Date.now() - startTime;

        // Record attempt
        if (patchState) {
          this.stateManager.addPatchAttempt(
            patchState.id,
            'enhanced_qwen',
            result.patch,
            result.error,
            undefined,
            undefined,
            duration,
            { attempt: attempts, level }
          );
        }

        if (result.success) {
          this.logger.success('PATCH_SUCCESS', `Patch generated successfully on attempt ${attempts}`);
          return result;
        } else {
          lastError = result.error || 'Unknown error';
          this.logger.warn('PATCH_FAILED', `Attempt ${attempts} failed: ${lastError}`);
        }

      } catch (error: any) {
        lastError = error.message;
        this.logger.error('PATCH_ERROR', `Attempt ${attempts} error: ${lastError}`);
        
        if (patchState) {
          this.stateManager.addPatchAttempt(
            patchState.id,
            'enhanced_qwen',
            undefined,
            lastError,
            [lastError],
            undefined,
            undefined,
            { attempt: attempts, level }
          );
        }
      }

      // Wait before retry (exponential backoff)
      if (attempts < this.config.maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempts - 1), 10000);
        await this.sleep(delay);
      }
    }

    return {
      success: false,
      error: `Failed after ${attempts} attempts. Last error: ${lastError}`,
      requires_approval: false
    };
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => 
        setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private findPatchStateId(repo: string, pr: number, commentId: string): string | undefined {
    const id = `${repo}-${pr}-*-*-*-${commentId}`;
    // This is a simplified lookup - in practice you'd want a more efficient method
    const report = this.stateManager.generateReport();
    const patch = report.patches.find(p => 
      p.repo === repo && 
      p.pr === pr && 
      p.commentId === commentId &&
      (p.status === 'APPLIED' || p.status === 'COMMITTED')
    );
    return patch?.id;
  }

  private reconstructPatchRequest(patchState: PatchState): PatchRequest | null {
    // Reconstruct from metadata - this would need to be implemented
    // based on how you store the original request
    return patchState.metadata?.originalRequest || null;
  }

  private generateRecommendations(stateReport: any, logSummary: any): string[] {
    const recommendations: string[] = [];

    if (stateReport.summary.failedPatches > stateReport.summary.appliedPatches) {
      recommendations.push('Consider reviewing patch generation logic - failure rate is high');
    }

    if (logSummary.errors.length > 10) {
      recommendations.push('High error count detected - review logs for common patterns');
    }

    if (stateReport.summary.pendingPatches > 5) {
      recommendations.push('Multiple pending patches - consider processing in batches');
    }

    const recentFailures = logSummary.errors.filter((e: any) => 
      new Date(e.timestamp).getTime() > Date.now() - 60 * 60 * 1000
    );

    if (recentFailures.length > 5) {
      recommendations.push('Recent spike in failures - check system health');
    }

    return recommendations;
  }
}
