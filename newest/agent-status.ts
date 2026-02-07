import Fastify from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { Webhooks } from '@octokit/webhooks';
import { Octokit } from '@octokit/rest';
import { Queue, Job, JobResult } from './queue';
import { ReviewParser } from './review-parser';
import { ConfigLoader } from './config-loader';
import { PatchGenerator } from './patch-generator';
import { GitOps } from './git-ops';
import { PRStateMachine } from './state-machine';
import { ParsedReviewComment, PatchRequest, PRConfig } from './types';
import * as crypto from 'crypto';

const PORT = Number(process.env.AGENT_PORT ?? '3000');

// Authentication: Support both Personal Access Token and GitHub App
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_PRIVATE_KEY;
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

interface ProcessJobData {
  comment: ParsedReviewComment;
  config: PRConfig;
  manual?: boolean;
}

export class PRAutopilotAgent {
  private fastify = Fastify({ logger: true });
  private queue = new Queue();
  private webhooks = new Webhooks({ secret: WEBHOOK_SECRET });
  private octokit: Octokit;
  private parser = new ReviewParser();
  private configLoader: ConfigLoader;
  private patchGenerator = new PatchGenerator();
  private gitOps: GitOps;
  private stateMachine = new PRStateMachine();

  constructor(startQueueProcessor = true) {
    // Validate authentication configuration
    const hasPersonalToken = !!GITHUB_TOKEN;
    const hasGitHubApp = !!(GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY);

    if (!hasPersonalToken && !hasGitHubApp) {
      throw new Error(
        'GitHub authentication required. Provide either:\n' +
        '  1. GITHUB_TOKEN (Personal Access Token), or\n' +
        '  2. GITHUB_APP_ID + GITHUB_PRIVATE_KEY (GitHub App)\n' +
        'See setup-github-app.ts for GitHub App setup instructions.'
      );
    }

    if (hasPersonalToken && hasGitHubApp) {
      console.warn('⚠️  Both GITHUB_TOKEN and GitHub App credentials provided. Using GITHUB_TOKEN.');
    }

    // Initialize Octokit with appropriate authentication
    if (hasPersonalToken) {
      console.log('🔑 Using Personal Access Token authentication');
      this.octokit = new Octokit({ auth: GITHUB_TOKEN });
    } else {
      console.log('🔑 Using GitHub App authentication');
      // TODO: Implement GitHub App authentication with @octokit/app
      throw new Error(
        'GitHub App authentication is not yet fully implemented.\n' +
        'Please use GITHUB_TOKEN (Personal Access Token) for now.\n' +
        'GitHub App support coming soon!'
      );
    }

    this.configLoader = new ConfigLoader(this.octokit);
    this.gitOps = new GitOps(GITHUB_TOKEN!);

    // Register raw body plugin FIRST, before any routes
    this.fastify.register(fastifyRawBody, {
      field: 'rawBody',
      global: false,
      encoding: 'utf8',
      runFirst: true
    });

    this.queue.registerHandler('process_pr', job => this.handleProcessJob(job));
    this.registerWebhookHandlers();
    
    // Only start the queue processor if requested (default true for backward compatibility)
    if (startQueueProcessor) {
      this.queue.start(1500);
    }
  }

  async start(): Promise<void> {
    this.fastify.post('/webhook', { config: { rawBody: true } }, async (request, reply) => {
      const deliveryId = request.headers['x-github-delivery'] as string;
      const eventName = request.headers['x-github-event'] as string;
      const signature = request.headers['x-hub-signature-256'] as string;
      
      // Check if rawBody is available, fallback to stringifying parsed body
      const rawBody = (request.rawBody as string) || (request.body ? JSON.stringify(request.body) : '');
      
      if (!rawBody) {
        this.fastify.log.error('No rawBody or body available in request');
        reply.code(400).send({ error: 'No body in request' });
        return;
      }

      if (!WEBHOOK_SECRET) {
        this.fastify.log.warn('No WEBHOOK_SECRET configured, skipping verification');
        reply.send({ ok: true });
        return;
      }

      try {
        // Verify signature with raw body
        const isValid = await this.webhooks.verify(rawBody, signature);
        if (!isValid) {
          throw new Error('Invalid signature');
        }

        // After verification, receive the parsed payload
        const parsedPayload = JSON.parse(rawBody);
        await this.webhooks.receive({
          id: deliveryId,
          name: eventName as any,
          payload: parsedPayload
        });
        
        reply.send({ ok: true });
      } catch (error: any) {
        this.fastify.log.error('Webhook verification failed', error?.message || error);
        reply.code(401).send({ error: 'Webhook verification failed' });
      }
    });

    await this.fastify.listen({ port: PORT, host: '0.0.0.0' });
  }

  async printStatus(): Promise<void> {
    const status = this.queue.getStatus();
    console.log('Queue status', status);
  }

  async enqueueManual(repoFull: string, pr: number): Promise<void> {
    if (!repoFull || !pr) {
      throw new Error('Repository and PR number are required to reprocess a PR.');
    }

    const { owner, repo } = this.splitRepo(repoFull);
    const prData = await this.octokit.rest.pulls.get({ owner, repo, pull_number: pr });
    const reviewComments = await this.octokit.paginate(this.octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: pr,
    });
    const reviews = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pr,
    });

    const inline = reviewComments
      .map(comment => this.parser.parseInlineComment({ comment, pull_request: prData.data }))
      .filter(Boolean) as ParsedReviewComment[];
    const reviewParsed = reviews.flatMap(review => this.parser.parseReview({ review, pull_request: prData.data }));
    const aggregated = [...inline, ...reviewParsed];

    await this.handleCommentEvent(repoFull, pr, aggregated);
    console.log(`Re-enqueued ${aggregated.length} comments for ${repoFull}#${pr}.`);
  }

  private registerWebhookHandlers(): void {
    this.webhooks.on('pull_request_review_comment', async (context: any) => {
      if (context.payload.action !== 'created') return;
      const repoFull = context.payload.repository?.full_name;
      const prNumber = context.payload.pull_request?.number;
      const comment = this.parser.parseInlineComment(context.payload);
      if (repoFull && prNumber && comment) {
        await this.handleCommentEvent(repoFull, prNumber, [comment]);
      }
    });

    this.webhooks.on('pull_request_review', async (context: any) => {
      if (context.payload.action !== 'submitted') return;
      const repoFull = context.payload.repository?.full_name;
      const prNumber = context.payload.pull_request?.number;
      const comments = this.parser.parseReview(context.payload);
      if (repoFull && prNumber) {
        await this.handleCommentEvent(repoFull, prNumber, comments);
      }
    });

    this.webhooks.on('issue_comment', async (context: any) => {
      if (context.payload.issue.pull_request) {
        const repoFull = context.payload.repository?.full_name;
        const prNumber = context.payload.issue.number;
        if (repoFull) {
          await this.handleIssueComment(repoFull, prNumber, context.payload.comment.body);
        }
      }
    });

    this.webhooks.on('pull_request', async (context: any) => {
      const repoFull = context.payload.repository?.full_name;
      if (repoFull && ['opened', 'reopened', 'synchronize'].includes(context.payload.action)) {
        this.stateMachine.resetState(repoFull, context.payload.number);
      }
    });
  }

  private async handleCommentEvent(repofull: string, pr: number, comments: (ParsedReviewComment | null)[]): Promise<void> {
    const cleanedComments = comments.filter(Boolean) as ParsedReviewComment[];
    if (!cleanedComments.length) return;

    const { owner, repo } = this.splitRepo(repofull);
    const config = await this.configLoader.loadConfig(owner, repo);

    const runnable = this.parser.filterComments(cleanedComments, config);
    for (const comment of runnable) {
      if (this.stateMachine.isCommentProcessed(repofull, pr, comment.id)) continue;
      this.queue.addJob('process_pr', repofull, pr, { comment, config }, 0);
    }
  }

  private async handleIssueComment(repofull: string, pr: number, body: string): Promise<void> {
    if (body.trim().startsWith('/stop-autofix')) {
      this.stateMachine.transition(repofull, pr, 'BLOCKED', 'Manual stop command received');
      await this.octokit.rest.issues.createComment({
        owner: this.splitRepo(repofull).owner,
        repo: this.splitRepo(repofull).repo,
        issue_number: pr,
        body: 'Auto-fixes halted for this PR. Remove `/stop-autofix` to resume.',
      });
    }
  }

  private splitRepo(repofull: string): { owner: string; repo: string } {
    const [owner = '', repo = ''] = repofull.split('/');
    return { owner, repo };
  }

  private determineAutomationLevel(comment: ParsedReviewComment, config: PRConfig): number {
    if (comment.type === 'suggested_change') {
      return 1;
    }

    if (config.autofix.risk_level === 'low' || this.parser.requiresApproval(comment, config.autofix.risk_level)) {
      return 3;
    }

    return 2;
  }

  private async handleProcessJob(job: Job): Promise<JobResult> {
    const data = job.data as ProcessJobData;
    if (!data?.comment) {
      return { success: false, error: 'Missing comment payload' };
    }

    const comment = data.comment;
    const { owner, repo } = this.splitRepo(job.repo);

    try {
      this.stateMachine.transition(job.repo, job.pr, 'FIXING');

      if (!comment.file) {
        return { success: true };
      }

      const pr = await this.octokit.rest.pulls.get({ owner, repo, pull_number: job.pr });
      const headSha = comment.commit_sha || pr.data.head.sha;
      const headRef = pr.data.head.ref;

      const patchRequest: PatchRequest = {
        repo: job.repo,
        pr: job.pr,
        commit_sha: headSha,
        file: comment.file,
        start_line: comment.start_line,
        end_line: comment.end_line,
        content: comment.content,
        context: comment.diff_hunk,
      };

      const level = this.determineAutomationLevel(comment, data.config);
      const patchResult = await this.patchGenerator.generatePatch(patchRequest, level);

      if (!patchResult.success || !patchResult.patch) {
        return { success: false, error: patchResult.error || 'Patch generation failed' };
      }

      if (patchResult.requires_approval) {
        await this.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: job.pr,
          body: `Generated a patch for comment ${comment.id} but marked for manual approval (level ${level}).`,
        });
        this.stateMachine.markCommentProcessed(job.repo, job.pr, comment.id);
        return { success: true };
      }

      await this.gitOps.clone(job.repo);
      await this.gitOps.checkout(job.repo, headRef);
      await this.gitOps.applyPatch(job.repo, patchResult.patch);
      const commitSha = await this.gitOps.commit(job.repo, `chore(pr-${job.pr}): apply review comment ${comment.id}`);
      await this.gitOps.push(job.repo, headRef);

      await this.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: job.pr,
        body: `Applied comment ${comment.id} (automation level ${level}). Re-running checks.`,
      });

      this.stateMachine.incrementIteration(job.repo, job.pr);
      this.stateMachine.markCommentProcessed(job.repo, job.pr, comment.id);
      this.stateMachine.transition(job.repo, job.pr, 'PUSHED');

      return { success: true };
    } catch (error: any) {
      this.stateMachine.transition(job.repo, job.pr, 'FAILED', error.message);
      return { success: false, error: error.message };
    }
  }
}

const command = process.argv[2];

if (command === 'status') {
  // Create agent without starting the queue processor for status checks
  const agent = new PRAutopilotAgent(false);
  agent.printStatus();
} else if (command === 'process') {
  const agent = new PRAutopilotAgent(true); // Start queue for processing
  const repo = process.argv[3];
  const pr = Number(process.argv[4]);
  agent.enqueueManual(repo, pr).catch(error => {
    console.error('Manual enqueue failed', error);
    process.exit(1);
  });
} else {
  const agent = new PRAutopilotAgent(true); // Start queue for normal operation
  agent.start().catch(error => {
    console.error('Agent failed to start', error);
    process.exit(1);
  });
}