import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PatchResult, ParsedReviewComment } from './types';

export interface PatchState {
  id: string;
  repo: string;
  pr: number;
  file: string;
  startLine: number;
  endLine: number;
  commentId: string;
  status: 'PENDING' | 'GENERATING' | 'GENERATED' | 'VALIDATING' | 'APPLYING' | 'APPLIED' | 'FAILED' | 'COMMITTED';
  attempts: PatchAttempt[];
  currentPatch?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: any;
}

export interface PatchAttempt {
  id: string;
  timestamp: string;
  method: 'mechanical' | 'traditional_llm' | 'enhanced_qwen' | 'repair';
  patch?: string;
  error?: string;
  validationErrors?: string[];
  repairAttempts?: number;
  duration?: number;
  metadata?: any;
}

export interface BatchCommitState {
  id: string;
  repo: string;
  pr: number;
  status: 'PENDING' | 'READY' | 'COMMITTING' | 'COMMITTED' | 'FAILED';
  patches: string[]; // Patch state IDs
  createdAt: string;
  updatedAt: string;
  commitSha?: string;
  error?: string;
}

export class PersistentPatchStateManager {
  private stateFile: string;
  private batchFile: string;
  private patchStates: Map<string, PatchState> = new Map();
  private batchStates: Map<string, BatchCommitState> = new Map();

  constructor() {
    const stateDir = path.join(os.tmpdir(), 'pr-autopilot-state');
    fs.mkdirSync(stateDir, { recursive: true });
    
    this.stateFile = path.join(stateDir, 'patch-states.json');
    this.batchFile = path.join(stateDir, 'batch-commits.json');
    
    this.loadStates();
  }

  createPatchState(
    repo: string,
    pr: number,
    file: string,
    startLine: number,
    endLine: number,
    commentId: string,
    metadata?: any
  ): PatchState {
    const id = `${repo}-${pr}-${file}-${startLine}-${endLine}-${commentId}`;
    
    const state: PatchState = {
      id,
      repo,
      pr,
      file,
      startLine,
      endLine,
      commentId,
      status: 'PENDING',
      attempts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata
    };

    this.patchStates.set(id, state);
    this.saveStates();
    return state;
  }

  getPatchState(id: string): PatchState | undefined {
    return this.patchStates.get(id);
  }

  updatePatchStatus(id: string, status: PatchState['status'], patch?: string, error?: string): void {
    const state = this.patchStates.get(id);
    if (!state) {
      throw new Error(`Patch state not found: ${id}`);
    }

    state.status = status;
    state.updatedAt = new Date().toISOString();
    
    if (patch !== undefined) {
      state.currentPatch = patch;
    }
    
    if (error !== undefined) {
      state.error = error;
    }

    this.saveStates();
  }

  addPatchAttempt(
    id: string,
    method: PatchAttempt['method'],
    patch?: string,
    error?: string,
    validationErrors?: string[],
    repairAttempts?: number,
    duration?: number,
    metadata?: any
  ): void {
    const state = this.patchStates.get(id);
    if (!state) {
      throw new Error(`Patch state not found: ${id}`);
    }

    const attempt: PatchAttempt = {
      id: `${id}-attempt-${state.attempts.length + 1}`,
      timestamp: new Date().toISOString(),
      method,
      patch,
      error,
      validationErrors,
      repairAttempts,
      duration,
      metadata
    };

    state.attempts.push(attempt);
    state.updatedAt = new Date().toISOString();
    
    this.saveStates();
  }

  createBatchCommit(repo: string, pr: number, patchIds: string[]): BatchCommitState {
    const id = `${repo}-${pr}-batch-${Date.now()}`;
    
    const batch: BatchCommitState = {
      id,
      repo,
      pr,
      status: 'PENDING',
      patches: patchIds,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.batchStates.set(id, batch);
    this.saveStates();
    return batch;
  }

  getBatchCommit(id: string): BatchCommitState | undefined {
    return this.batchStates.get(id);
  }

  updateBatchStatus(id: string, status: BatchCommitState['status'], commitSha?: string, error?: string): void {
    const batch = this.batchStates.get(id);
    if (!batch) {
      throw new Error(`Batch state not found: ${id}`);
    }

    batch.status = status;
    batch.updatedAt = new Date().toISOString();
    
    if (commitSha !== undefined) {
      batch.commitSha = commitSha;
    }
    
    if (error !== undefined) {
      batch.error = error;
    }

    this.saveStates();
  }

  getPendingPatches(repo?: string, pr?: number): PatchState[] {
    const patches = Array.from(this.patchStates.values());
    
    return patches.filter(patch => {
      if (patch.status !== 'PENDING' && patch.status !== 'FAILED') {
        return false;
      }
      
      if (repo && patch.repo !== repo) {
        return false;
      }
      
      if (pr && patch.pr !== pr) {
        return false;
      }
      
      return true;
    });
  }

  getAppliedPatches(repo?: string, pr?: number): PatchState[] {
    const patches = Array.from(this.patchStates.values());
    
    return patches.filter(patch => {
      if (patch.status !== 'APPLIED' && patch.status !== 'COMMITTED') {
        return false;
      }
      
      if (repo && patch.repo !== repo) {
        return false;
      }
      
      if (pr && patch.pr !== pr) {
        return false;
      }
      
      return true;
    });
  }

  getFailedPatches(repo?: string, pr?: number): PatchState[] {
    const patches = Array.from(this.patchStates.values());
    
    return patches.filter(patch => {
      if (patch.status !== 'FAILED') {
        return false;
      }
      
      if (repo && patch.repo !== repo) {
        return false;
      }
      
      if (pr && patch.pr !== pr) {
        return false;
      }
      
      return true;
    });
  }

  recoverPendingWork(): {
    pendingPatches: PatchState[];
    pendingBatches: BatchCommitState[];
    failedPatches: PatchState[];
    recoveryReport?: string;
  } {
    const pendingPatches = this.getPendingPatches();
    const pendingBatches = Array.from(this.batchStates.values()).filter(
      batch => batch.status === 'PENDING' || batch.status === 'READY'
    );
    const failedPatches = this.getFailedPatches();

    // Generate recovery report
    const recoveryReport = this.generateRecoveryReport(pendingPatches, pendingBatches, failedPatches);

    return {
      pendingPatches,
      pendingBatches,
      failedPatches,
      recoveryReport
    };
  }

  /**
   * Generate a recovery report for pending work
   */
  private generateRecoveryReport(
    pendingPatches: PatchState[],
    pendingBatches: BatchCommitState[],
    failedPatches: PatchState[]
  ): string {
    let report = '\n╔══════════════════════════════════════════════════════════════╗\n';
    report += '║           PENDING WORK RECOVERY REPORT                      ║\n';
    report += '╚══════════════════════════════════════════════════════════════╝\n\n';

    report += `📊 Summary:\n`;
    report += `   - Pending patches: ${pendingPatches.length}\n`;
    report += `   - Pending batches: ${pendingBatches.length}\n`;
    report += `   - Failed patches (retryable): ${failedPatches.length}\n\n`;

    if (pendingPatches.length > 0) {
      report += `📝 Pending Patches:\n`;
      for (const patch of pendingPatches.slice(0, 10)) {
        report += `   - ${patch.repo}#${patch.pr}: ${patch.file}:${patch.startLine}-${patch.endLine}\n`;
        report += `     Status: ${patch.status}, Attempts: ${patch.attempts.length}\n`;
        if (patch.error) {
          report += `     Last error: ${patch.error.substring(0, 100)}...\n`;
        }
      }
      if (pendingPatches.length > 10) {
        report += `   ... and ${pendingPatches.length - 10} more\n`;
      }
      report += '\n';
    }

    if (pendingBatches.length > 0) {
      report += `📦 Pending Batches:\n`;
      for (const batch of pendingBatches) {
        report += `   - ${batch.repo}#${batch.pr}: ${batch.patches.length} patches\n`;
        report += `     Status: ${batch.status}, Created: ${new Date(batch.createdAt).toLocaleString()}\n`;
      }
      report += '\n';
    }

    if (failedPatches.length > 0) {
      report += `⚠️  Failed Patches (can retry):\n`;
      for (const patch of failedPatches.slice(0, 5)) {
        report += `   - ${patch.repo}#${patch.pr}: ${patch.file}\n`;
        report += `     Error: ${patch.error?.substring(0, 80)}...\n`;
      }
      if (failedPatches.length > 5) {
        report += `   ... and ${failedPatches.length - 5} more\n`;
      }
      report += '\n';
    }

    return report;
  }

  /**
   * Save state immediately (for crash resilience)
   */
  flushState(): void {
    this.saveStates();
  }

  /**
   * Get state for a specific comment
   */
  getStateForComment(repo: string, pr: number, commentId: string): PatchState | undefined {
    const id = `${repo}-${pr}-.*-${commentId}`;
    const regex = new RegExp(id);
    
    for (const [key, state] of this.patchStates.entries()) {
      if (regex.test(key) && state.commentId === commentId) {
        return state;
      }
    }
    return undefined;
  }

  retryFailedPatches(repo?: string, pr?: number): PatchState[] {
    const failedPatches = this.getFailedPatches(repo, pr);
    const retried: PatchState[] = [];

    for (const patch of failedPatches) {
      // Reset to pending status
      this.updatePatchStatus(patch.id, 'PENDING');
      retried.push(patch);
    }

    return retried;
  }

  cleanupOldStates(maxAgeHours: number = 24): void {
    const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
    let cleanedCount = 0;

    // Clean up old patch states
    for (const [id, state] of this.patchStates.entries()) {
      const stateTime = new Date(state.updatedAt).getTime();
      if (stateTime < cutoffTime && 
          (state.status === 'COMMITTED' || state.status === 'FAILED')) {
        this.patchStates.delete(id);
        cleanedCount++;
      }
    }

    // Clean up old batch states
    for (const [id, batch] of this.batchStates.entries()) {
      const batchTime = new Date(batch.updatedAt).getTime();
      if (batchTime < cutoffTime && 
          (batch.status === 'COMMITTED' || batch.status === 'FAILED')) {
        this.batchStates.delete(id);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.saveStates();
      console.log(`Cleaned up ${cleanedCount} old states`);
    }
  }

  generateReport(): {
    summary: {
      totalPatches: number;
      pendingPatches: number;
      appliedPatches: number;
      failedPatches: number;
      totalBatches: number;
      pendingBatches: number;
      committedBatches: number;
    };
    patches: PatchState[];
    batches: BatchCommitState[];
  } {
    const patches = Array.from(this.patchStates.values());
    const batches = Array.from(this.batchStates.values());

    const summary = {
      totalPatches: patches.length,
      pendingPatches: patches.filter(p => p.status === 'PENDING').length,
      appliedPatches: patches.filter(p => p.status === 'APPLIED' || p.status === 'COMMITTED').length,
      failedPatches: patches.filter(p => p.status === 'FAILED').length,
      totalBatches: batches.length,
      pendingBatches: batches.filter(b => b.status === 'PENDING' || b.status === 'READY').length,
      committedBatches: batches.filter(b => b.status === 'COMMITTED').length
    };

    return {
      summary,
      patches: patches.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
      batches: batches.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    };
  }

  private loadStates(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const patchData = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        for (const state of patchData) {
          this.patchStates.set(state.id, state);
        }
      }

      if (fs.existsSync(this.batchFile)) {
        const batchData = JSON.parse(fs.readFileSync(this.batchFile, 'utf8'));
        for (const batch of batchData) {
          this.batchStates.set(batch.id, batch);
        }
      }

      console.log(`Loaded ${this.patchStates.size} patch states and ${this.batchStates.size} batch states`);
    } catch (error) {
      console.warn('Failed to load existing states:', error);
    }
  }

  private saveStates(): void {
    try {
      const patchData = Array.from(this.patchStates.values());
      const batchData = Array.from(this.batchStates.values());

      fs.writeFileSync(this.stateFile, JSON.stringify(patchData, null, 2));
      fs.writeFileSync(this.batchFile, JSON.stringify(batchData, null, 2));
    } catch (error) {
      console.error('Failed to save states:', error);
    }
  }
}
