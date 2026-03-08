import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Queue, registerCleanup, runCleanup, runAllCleanup } from '../../scripts/queue';

describe('Queue', () => {
  let queue: Queue;

  beforeEach(() => {
    queue = new Queue();
  });

  afterEach(() => {
    queue.stop();
  });

  describe('registerHandler', () => {
    it('should register a handler', () => {
      const handler = vi.fn();
      queue.registerHandler('test_type', handler);

      // Handler should be registered (we verify by adding a job)
      queue.addJob('test_type', 'owner/repo', 1, {}, 0);
      
      const status = queue.getStatus();
      expect(status.queueLength).toBe(1);
    });
  });

  describe('addJob', () => {
    it('should add a job to the queue', () => {
      const jobId = queue.addJob('process_pr', 'owner/repo', 123, { test: true }, 0);

      expect(jobId).toBeDefined();
      expect(jobId).toContain('process_pr');

      const status = queue.getStatus();
      expect(status.queueLength).toBe(1);
      expect(status.jobs[0].repo).toBe('owner/repo');
      expect(status.jobs[0].pr).toBe(123);
    });

    it('should sort jobs by priority', () => {
      queue.addJob('process_pr', 'owner/repo', 1, {}, 0);
      queue.addJob('process_pr', 'owner/repo', 2, {}, 10);
      queue.addJob('process_pr', 'owner/repo', 3, {}, 5);

      const status = queue.getStatus();
      expect(status.jobs[0].pr).toBe(2); // Highest priority
      expect(status.jobs[1].pr).toBe(3);
      expect(status.jobs[2].pr).toBe(1); // Lowest priority
    });

    it('should include timestamp', () => {
      const before = Date.now();
      const jobId = queue.addJob('process_pr', 'owner/repo', 123, {}, 0);
      const after = Date.now();

      const status = queue.getStatus();
      expect(status.jobs[0].createdAt).toBeGreaterThanOrEqual(before);
      expect(status.jobs[0].createdAt).toBeLessThanOrEqual(after);
    });
  });

  describe('getStatus', () => {
    it('should return empty queue status', () => {
      const status = queue.getStatus();

      expect(status.queueLength).toBe(0);
      expect(status.processingCount).toBe(0);
      expect(status.jobs).toEqual([]);
    });

    it('should return correct queue status', () => {
      queue.addJob('process_pr', 'owner/repo', 1, {}, 0);
      queue.addJob('process_pr', 'owner/repo', 2, {}, 0);

      const status = queue.getStatus();

      expect(status.queueLength).toBe(2);
      expect(status.processingCount).toBe(0);
    });
  });

  describe('clear', () => {
    it('should clear the queue', () => {
      queue.addJob('process_pr', 'owner/repo', 1, {}, 0);
      queue.addJob('process_pr', 'owner/repo', 2, {}, 0);

      queue.clear();

      const status = queue.getStatus();
      expect(status.queueLength).toBe(0);
    });
  });

  describe('processing', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should process jobs', async () => {
      vi.useFakeTimers();
      const handler = vi.fn().mockResolvedValue({ success: true });
      queue.registerHandler('test', handler);

      queue.addJob('test', 'owner/repo', 123, {}, 0);
      queue.start(100);

<<<<<<< HEAD
      // Advance timers to trigger processing
      await vi.advanceTimersByTimeAsync(200);
=======
      await vi.advanceTimersByTimeAsync(200);

      expect(handler).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should retry failed jobs', async () => {
>>>>>>> origin/autopilot/pr-2-fixes

      expect(handler).toHaveBeenCalled();
    });

    it('should retry failed jobs', async () => {
      const handler = vi.fn()
        .mockRejectedValueOnce(new Error('First failure'))
        .mockResolvedValue({ success: true });

      queue.registerHandler('test', handler);
      queue.addJob('test', 'owner/repo', 123, {}, 0);
      queue.start(100);

      // Advance timers to allow processing and retry
      await vi.advanceTimersByTimeAsync(500);

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should stop after max retries', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Always fails'));

      queue.registerHandler('test', handler);
      queue.addJob('test', 'owner/repo', 123, {}, 0);
      queue.start(100);

      // Advance timers sufficiently for all retries
      await vi.advanceTimersByTimeAsync(1000);

      // Default max retries is 3
      expect(handler.mock.calls.length).toBeLessThanOrEqual(4);
    });
  });

  describe('concurrency', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should limit concurrent processing', async () => {
      let activeCount = 0;
      let maxActive = 0;

      const handler = vi.fn().mockImplementation(async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise(resolve => setTimeout(resolve, 100));
        activeCount--;
        return { success: true };
      });

      queue.registerHandler('test', handler);

      // Add more jobs than the concurrency limit (5)
      for (let i = 0; i < 10; i++) {
        queue.addJob('test', 'owner/repo', i, {}, 0);
      }

      queue.start(50);
      await vi.advanceTimersByTimeAsync(500);

      // Max concurrent should be at most 5
      expect(maxActive).toBeLessThanOrEqual(5);
    });
  });
});

describe('Cleanup Registry', () => {
  it('should register cleanup functions', () => {
    const cleanupFn = vi.fn();
    registerCleanup('test-id', cleanupFn);

    runCleanup('test-id');

    expect(cleanupFn).toHaveBeenCalled();
  });

  it('should run all cleanup functions', () => {
    const cleanup1 = vi.fn();
    const cleanup2 = vi.fn();

    registerCleanup('test-1', cleanup1);
    registerCleanup('test-2', cleanup2);

    runAllCleanup();

    expect(cleanup1).toHaveBeenCalled();
    expect(cleanup2).toHaveBeenCalled();
  });

  it('should handle cleanup errors gracefully', () => {
    const badCleanup = vi.fn().mockImplementation(() => {
      throw new Error('Cleanup failed');
    });
    const goodCleanup = vi.fn();

    registerCleanup('test-bad', badCleanup);
    registerCleanup('test-good', goodCleanup);

    // Should not throw
    expect(() => runAllCleanup()).not.toThrow();
    expect(goodCleanup).toHaveBeenCalled();
  });
});
