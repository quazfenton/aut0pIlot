import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PRStateMachine } from '../../scripts/state-machine';
import { ParsedReviewComment } from '../../scripts/types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('PRStateMachine', () => {
  let stateMachine: PRStateMachine;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
    stateMachine = new PRStateMachine(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('getState', () => {
    it('should create new state for unknown PR', () => {
      const state = stateMachine.getState('owner/repo', 123);

      expect(state.repo).toBe('owner/repo');
      expect(state.pr).toBe(123);
      expect(state.state).toBe('NEW');
      expect(state.iteration).toBe(0);
      expect(state.comments_processed).toEqual([]);
    });

    it('should return existing state for known PR', () => {
      stateMachine.getState('owner/repo', 123);
      stateMachine.transition('owner/repo', 123, 'REVIEWED');

      const state = stateMachine.getState('owner/repo', 123);
      expect(state.state).toBe('REVIEWED');
    });
  });

  describe('transition', () => {
    it('should transition state', () => {
      stateMachine.transition('owner/repo', 123, 'FIXING');
      
      const state = stateMachine.getState('owner/repo', 123);
      expect(state.state).toBe('FIXING');
    });

    it('should store reason when provided', () => {
      stateMachine.transition('owner/repo', 123, 'BLOCKED', 'Manual stop command');
      
      const state = stateMachine.getState('owner/repo', 123);
      expect(state.blocked_reason).toBe('Manual stop command');
    });
  });

  describe('incrementIteration', () => {
    it('should increment iteration count', () => {
      const iter1 = stateMachine.incrementIteration('owner/repo', 123);
      const iter2 = stateMachine.incrementIteration('owner/repo', 123);

      expect(iter1).toBe(1);
      expect(iter2).toBe(2);
    });
  });

  describe('markCommentProcessed', () => {
    it('should track processed comments', () => {
      stateMachine.markCommentProcessed('owner/repo', 123, 'comment-1');
      stateMachine.markCommentProcessed('owner/repo', 123, 'comment-2');

      const state = stateMachine.getState('owner/repo', 123);
      expect(state.comments_processed).toContain('comment-1');
      expect(state.comments_processed).toContain('comment-2');
    });

    it('should not duplicate processed comments', () => {
      stateMachine.markCommentProcessed('owner/repo', 123, 'comment-1');
      stateMachine.markCommentProcessed('owner/repo', 123, 'comment-1');

      const state = stateMachine.getState('owner/repo', 123);
      expect(state.comments_processed.filter(id => id === 'comment-1')).toHaveLength(1);
    });
  });

  describe('isCommentProcessed', () => {
    it('should return true for processed comments', () => {
      stateMachine.markCommentProcessed('owner/repo', 123, 'comment-1');

      expect(stateMachine.isCommentProcessed('owner/repo', 123, 'comment-1')).toBe(true);
    });

    it('should return false for unprocessed comments', () => {
      expect(stateMachine.isCommentProcessed('owner/repo', 123, 'unknown')).toBe(false);
    });
  });

  describe('unmarkCommentProcessed', () => {
    it('should remove comment from processed list', () => {
      stateMachine.markCommentProcessed('owner/repo', 123, 'comment-1');
      stateMachine.unmarkCommentProcessed('owner/repo', 123, 'comment-1');

      expect(stateMachine.isCommentProcessed('owner/repo', 123, 'comment-1')).toBe(false);
    });
  });

  describe('resetState', () => {
    it('should reset state to REVIEWED', () => {
      stateMachine.transition('owner/repo', 123, 'FIXING');
      stateMachine.incrementIteration('owner/repo', 123);
      stateMachine.resetState('owner/repo', 123);

      const state = stateMachine.getState('owner/repo', 123);
      expect(state.state).toBe('REVIEWED');
      expect(state.iteration).toBe(1); // Iteration is preserved
    });
  });

  describe('deleteState', () => {
    it('should remove state', () => {
      stateMachine.getState('owner/repo', 123);
      stateMachine.deleteState('owner/repo', 123);

      const state = stateMachine.getState('owner/repo', 123);
      // Should create a new state
      expect(state.state).toBe('NEW');
    });
  });

  describe('pending comments', () => {
    const mockComment = (id: string): ParsedReviewComment => ({
      id,
      file: 'test.ts',
      start_line: 1,
      end_line: 1,
      type: 'inline_comment',
      content: 'test',
      author: 'reviewer',
      commit_sha: 'abc',
    });

    it('should add pending comments', () => {
      stateMachine.addPendingComments('owner/repo', 123, [mockComment('c1')]);

      const pending = stateMachine.getAndClearPendingComments('owner/repo', 123);
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('c1');
    });

    it('should not duplicate pending comments', () => {
      stateMachine.addPendingComments('owner/repo', 123, [mockComment('c1')]);
      stateMachine.addPendingComments('owner/repo', 123, [mockComment('c1')]);

      const pending = stateMachine.getAndClearPendingComments('owner/repo', 123);
      expect(pending).toHaveLength(1);
    });

    it('should not add already processed comments', () => {
      stateMachine.markCommentProcessed('owner/repo', 123, 'c1');
      stateMachine.addPendingComments('owner/repo', 123, [mockComment('c1')]);

      const pending = stateMachine.getAndClearPendingComments('owner/repo', 123);
      expect(pending).toHaveLength(0);
    });

    it('should clear pending comments after retrieval', () => {
      stateMachine.addPendingComments('owner/repo', 123, [mockComment('c1')]);
      
      stateMachine.getAndClearPendingComments('owner/repo', 123);
      const pending = stateMachine.getAndClearPendingComments('owner/repo', 123);

      expect(pending).toHaveLength(0);
    });
  });

  describe('helper branch', () => {
    it('should track helper branch', () => {
      stateMachine.setHelperBranch('owner/repo', 123, 'autopilot/pr-123-fixes');

      const branch = stateMachine.getHelperBranch('owner/repo', 123);
      expect(branch).toBe('autopilot/pr-123-fixes');
    });

    it('should allow undefined helper branch', () => {
      stateMachine.setHelperBranch('owner/repo', 123, 'branch-1');
      stateMachine.setHelperBranch('owner/repo', 123, undefined);

      const branch = stateMachine.getHelperBranch('owner/repo', 123);
      expect(branch).toBeUndefined();
    });
  });

  describe('getActiveStates', () => {
    it('should return only active states', () => {
      stateMachine.transition('owner/repo', 123, 'FIXING');
      stateMachine.transition('owner/repo', 456, 'BLOCKED');
      stateMachine.transition('owner/repo', 789, 'FAILED');

      const active = stateMachine.getActiveStates();

      expect(active.find(s => s.pr === 123)).toBeDefined();
      expect(active.find(s => s.pr === 456)).toBeUndefined();
      expect(active.find(s => s.pr === 789)).toBeUndefined();
    });
  });

  describe('persistence', () => {
    it('should persist state to disk', () => {
      stateMachine.transition('owner/repo', 123, 'FIXING');

      // Create a new state machine to load from disk
      const newMachine = new PRStateMachine(tempDir);
      const state = newMachine.getState('owner/repo', 123);

      expect(state.state).toBe('FIXING');
    });
  });
});
