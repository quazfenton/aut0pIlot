import { PRState, ParsedReviewComment } from './types';
import * as fs from 'fs';
import * as path from 'path';

export class PRStateMachine {
  private states: Map<string, PRState> = new Map();
  private stateFile: string;

  constructor(stateDir: string = '/tmp/pr-autopilot-states') {
    this.stateFile = path.join(stateDir, 'states.json');
    console.log(`[STATE] PRStateMachine initialized with state file: ${this.stateFile}`);
    this.loadStates();
  }

  /**
   * Load states from disk
   */
  private loadStates(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = fs.readFileSync(this.stateFile, 'utf-8');
        const parsed = JSON.parse(data);
        this.states = new Map(
          Object.entries(parsed).map(([key, value]) => [key, value as PRState])
        );
        console.log(`[STATE] Loaded ${this.states.size} states from ${this.stateFile}`);
      } else {
        console.log(`[STATE] No state file found at ${this.stateFile}, starting fresh`);
      }
    } catch (error) {
      console.error('[STATE] Error loading states:', error);
      this.states = new Map();
    }
  }

  /**
   * Save states to disk
   */
  private saveStates(): void {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`[STATE] Created state directory: ${dir}`);
      }

      const data = Object.fromEntries(this.states);
      fs.writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
      console.log(`[STATE] Saved ${this.states.size} states to ${this.stateFile}`);
    } catch (error) {
      console.error('[STATE] Error saving states:', error);
    }
  }

  /**
   * Get state key for a PR
   */
  private getStateKey(repo: string, pr: number): string {
    return `${repo}#${pr}`;
  }

  /**
   * Get or create state for a PR
   */
  getState(repo: string, pr: number): PRState {
    const key = this.getStateKey(repo, pr);
    if (!this.states.has(key)) {
      const newState: PRState = {
        repo,
        pr,
        state: 'NEW',
        iteration: 0,
        comments_processed: [],
      };
      this.states.set(key, newState);
      this.saveStates();
      return newState;
    }
    return this.states.get(key)!;
  }

  /**
   * Update state for a PR
   */
  updateState(repo: string, pr: number, updates: Partial<PRState>): void {
    const key = this.getStateKey(repo, pr);
    const currentState = this.getState(repo, pr);
    
    this.states.set(key, {
      ...currentState,
      ...updates,
    });
    
    this.saveStates();
  }

  /**
   * Transition state
   */
  transition(repo: string, pr: number, newState: PRState['state'], reason?: string): void {
    const updates: Partial<PRState> = { state: newState };
    
    if (reason) {
      updates.blocked_reason = reason;
    }

    this.updateState(repo, pr, updates);
  }

  /**
   * Increment iteration
   */
  incrementIteration(repo: string, pr: number): number {
    const state = this.getState(repo, pr);
    const newIteration = state.iteration + 1;
    this.updateState(repo, pr, { iteration: newIteration });
    return newIteration;
  }

  /**
   * Mark comment as processed
   */
  markCommentProcessed(repo: string, pr: number, commentId: string): void {
    const state = this.getState(repo, pr);
    const processed = new Set(state.comments_processed);
    processed.add(commentId);
    this.updateState(repo, pr, { comments_processed: Array.from(processed) });
  }

  /**
   * Check if comment was already processed
   */
  isCommentProcessed(repo: string, pr: number, commentId: string): boolean {
    const state = this.getState(repo, pr);
    return state.comments_processed.includes(commentId);
  }

  /**
   * Unmark comment as processed (to allow reprocessing)
   */
  unmarkCommentProcessed(repo: string, pr: number, commentId: string): void {
    const state = this.getState(repo, pr);
    const processed = new Set(state.comments_processed);
    processed.delete(commentId);
    this.updateState(repo, pr, { comments_processed: Array.from(processed) });
  }

  /**
   * Reset state for a PR (e.g., on new commits)
   */
  resetState(repo: string, pr: number): void {
    const key = this.getStateKey(repo, pr);
    const currentState = this.getState(repo, pr);
    
    // Keep iteration count but reset to REVIEWED state
    this.states.set(key, {
      ...currentState,
      state: 'REVIEWED',
      last_commit: undefined,
    });
    
    this.saveStates();
  }

  /**
   * Delete state for a PR (e.g., when PR is closed)
   */
  deleteState(repo: string, pr: number): void {
    const key = this.getStateKey(repo, pr);
    this.states.delete(key);
    this.saveStates();
  }

  /**
   * Get all active states
   */
  getActiveStates(): PRState[] {
    return Array.from(this.states.values()).filter(
      s => !['BLOCKED', 'FAILED'].includes(s.state)
    );
  }

  /**
   * Clean up old states (older than 24 hours)
   */
  cleanupOldStates(): void {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    // This is a simplified cleanup - in production, you'd want to track timestamps
    // For now, we'll just keep states for active PRs
  }

  /**
   * Add pending comments to a PR
   */
  addPendingComments(repo: string, pr: number, comments: ParsedReviewComment[]): void {
    const state = this.getState(repo, pr);
    const pending = [...(state.pending_comments || [])];
    const processed = new Set(state.comments_processed);

    console.log(`[STATE] addPendingComments: ${repo}#${pr} - Adding ${comments.length} comments`);
    console.log(`[STATE] Current pending: ${pending.length}, Processed: ${processed.size}`);

    let added = 0;
    let skipped = 0;
    
    for (const comment of comments) {
      const alreadyPending = pending.some(c => c.id === comment.id);
      const alreadyProcessed = processed.has(comment.id);
      
      if (!alreadyPending && !alreadyProcessed) {
        pending.push(comment);
        added++;
        console.log(`[STATE] Added comment ${comment.id} to pending`);
      } else {
        skipped++;
        console.log(`[STATE] Skipped comment ${comment.id} - pending: ${alreadyPending}, processed: ${alreadyProcessed}`);
      }
    }

    console.log(`[STATE] After add: ${pending.length} pending (${added} added, ${skipped} skipped)`);
    this.updateState(repo, pr, { pending_comments: pending });
  }

  /**
   * Get and clear pending comments for a PR
   */
  getAndClearPendingComments(repo: string, pr: number): ParsedReviewComment[] {
    const state = this.getState(repo, pr);
    const pending = state.pending_comments || [];
    
    console.log(`[STATE] getAndClearPendingComments: ${repo}#${pr}`);
    console.log(`[STATE] Found ${pending.length} pending comments`);
    console.log(`[STATE] Processed comments: ${state.comments_processed.length}`);
    
    if (pending.length > 0) {
      console.log(`[STATE] Pending comment IDs: ${pending.map(c => c.id).join(', ')}`);
    }
    
    this.updateState(repo, pr, { pending_comments: [] });
    console.log(`[STATE] Cleared pending comments for ${repo}#${pr}`);
    
    return pending;
  }
  getHelperBranch(repo: string, pr: number): string | undefined {
    return this.getState(repo, pr).helper_branch;
  }

  /**
   * Set helper branch for a PR
   */
  setHelperBranch(repo: string, pr: number, branch: string | undefined): void {
    this.updateState(repo, pr, { helper_branch: branch });
  }
}
