export interface Job {
  id: string;
  type: 'process_pr' | 'apply_patch' | 'push_commit';
  repo: string;
  pr: number;
  data?: any;
  priority: number;
  createdAt: number;
  retries: number;
  maxRetries: number;
}

export interface JobResult {
  success: boolean;
  error?: string;
  data?: any;
}

export class Queue {
  private queue: Job[] = [];
  private processing: Set<string> = new Set();
  private handlers: Map<string, (job: Job) => Promise<JobResult>> = new Map();
  private intervalId: NodeJS.Timeout | null = null;

  /**
   * Register a job handler
   */
  registerHandler(type: string, handler: (job: Job) => Promise<JobResult>): void {
    this.handlers.set(type, handler);
  }

  /**
   * Add a job to the queue
   */
  addJob(
    type: Job['type'],
    repo: string,
    pr: number,
    data?: any,
    priority: number = 0
  ): string {
    const job: Job = {
      id: `${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      repo,
      pr,
      data,
      priority,
      createdAt: Date.now(),
      retries: 0,
      maxRetries: 3,
    };

    this.queue.push(job);
    // Sort by priority (higher first)
    this.queue.sort((a, b) => b.priority - a.priority);

    console.log(`Job queued: ${job.id} (${type} for ${repo}#${pr})`);
    return job.id;
  }

  /**
   * Start processing the queue
   */
  start(interval: number = 1000): void {
    if (this.intervalId) {
      console.warn('Queue already started');
      return;
    }

    console.log('Starting queue processor...');
    this.intervalId = setInterval(() => this.processQueue(), interval);
  }

  /**
   * Stop processing the queue
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('Queue processor stopped');
    }
  }

  /**
   * Process the queue
   */
  private async processQueue(): Promise<void> {
    if (this.queue.length === 0 || this.processing.size >= 5) {
      // Concurrency limit of 5
      return;
    }

    const job = this.queue.shift();
    if (!job) return;

    this.processing.add(job.id);

    try {
      console.log(`Processing job: ${job.id}`);
      
      const handler = this.handlers.get(job.type);
      if (!handler) {
        throw new Error(`No handler registered for type: ${job.type}`);
      }

      const result = await handler(job);

      if (!result.success) {
        console.error(`Job failed: ${job.id} - ${result.error}`);
        
        // Retry if under max retries
        if (job.retries < job.maxRetries) {
          job.retries++;
          job.priority = -1; // Lower priority for retries
          this.queue.push(job);
          console.log(`Retrying job: ${job.id} (${job.retries}/${job.maxRetries})`);
        } else {
          console.error(`Job max retries reached: ${job.id}`);
          // Emit failure event or notify
        }
      } else {
        console.log(`Job completed: ${job.id}`);
      }
    } catch (error: any) {
      console.error(`Job error: ${job.id}`, error.message);
      
      // Retry if under max retries
      if (job.retries < job.maxRetries) {
        job.retries++;
        job.priority = -1;
        this.queue.push(job);
      }
    } finally {
      this.processing.delete(job.id);
    }
  }

  /**
   * Get queue status
   */
  getStatus(): { queueLength: number; processingCount: number; jobs: Job[] } {
    return {
      queueLength: this.queue.length,
      processingCount: this.processing.size,
      jobs: this.queue,
    };
  }

  /**
   * Clear the queue
   */
  clear(): void {
    this.queue = [];
    console.log('Queue cleared');
  }
}
