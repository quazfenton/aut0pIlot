import Fastify from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { Webhooks } from '@octokit/webhooks';
import { Octokit } from '@octokit/rest';
import { Queue, Job, JobResult, registerCleanup, runAllCleanup } from './queue';
import { ReviewParser } from './review-parser';
import { ConfigLoader } from './config-loader';
import { PatchGenerator } from './patch-generator';
import { GitOps } from './git-ops';
import { PRStateMachine } from './state-machine';
import { CommentTracker, TrackedComment } from './comment-tracker';
import { ParsedReviewComment, PatchRequest, PRConfig } from './types';
import { ApprovalManager } from './approval-manager';
import * as crypto from 'crypto';

const c = {
  job:     (msg: string) => console.log(`\x1b[34m[JOB]\x1b[0m ${msg}`),
  handler: (msg: string) => console.log(`\x1b[35m[HANDLER]\x1b[0m ${msg}`),
  webhook: (msg: string) => console.log(`\x1b[36m[WEBHOOK]\x1b[0m ${msg}`),
  comment: (msg: string) => console.log(`\x1b[33m[COMMENT]\x1b[0m ${msg}`),
  filter:  (msg: string) => console.log(`\x1b[2m[FILTER]\x1b[0m ${msg}`),
  error:   (msg: string) => console.log(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
  success: (msg: string) => console.log(`\x1b[1;32m[OK]\x1b[0m ${msg}`),
  commit:  (msg: string) => console.log(`\x1b[1;35m[COMMIT]\x1b[0m ${msg}`),  // Bright magenta for commits
  push:    (msg: string) => console.log(`\x1b[1;36m[PUSH]\x1b[0m ${msg}`),    // Bright cyan for pushes
  patch:   (msg: string) => console.log(`\x1b[38;5;208m[PATCH]\x1b[0m ${msg}`), // Orange for patches
  git:     (msg: string) => console.log(`\x1b[38;5;240m[GIT]\x1b[0m ${msg}`),   // Gray for git operations
};

const PORT = Number(process.env.AGENT_PORT ?? '3000');

// Authentication: Support both Personal Access Token and GitHub App
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_PRIVATE_KEY;
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

interface ProcessJobData {
  config: PRConfig;
  manual?: boolean;
}

export class PRAutopilotAgent {
  private fastify = Fastify({ logger: true });
  private queue = new Queue();
  private webhooks: Webhooks;
  private octokit: Octokit;
  private parser = new ReviewParser();
  private configLoader: ConfigLoader;
  private patchGenerator: PatchGenerator;
  private gitOps: GitOps;
  private stateMachine = new PRStateMachine();
  private commentTracker = new CommentTracker();
  private approvalManager: ApprovalManager;
  private cleanupRegistered = false;

  constructor() {
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
      console.warn('⚠️  Multiple auth methods configured. Using GITHUB_TOKEN.');
    }

    // Initialize Octokit with appropriate authentication
    if (hasPersonalToken) {
      console.log('🔑 Using token authentication');
      this.octokit = new Octokit({ auth: GITHUB_TOKEN });
    } else {
      console.log('🔑 Using GitHub App authentication');
      throw new Error(
        'GitHub App authentication is not yet fully implemented.\n' +
        'Please use GITHUB_TOKEN (Personal Access Token) for now.\n' +
        'GitHub App support coming soon!'
      );
    }

    this.configLoader = new ConfigLoader(this.octokit);
    this.gitOps = new GitOps(GITHUB_TOKEN!);
    // CRITICAL: Pass shared gitOps to PatchGenerator to avoid multiple clone directories
    this.patchGenerator = new PatchGenerator(this.gitOps);
    this.webhooks = new Webhooks({ secret: WEBHOOK_SECRET });
    this.approvalManager = new ApprovalManager(this.octokit);

    // Register raw body plugin FIRST, before any routes
    this.fastify.register(fastifyRawBody, {
      field: 'rawBody',
      global: false,
      encoding: 'utf8',
      runFirst: true
    });

    this.queue.registerHandler('process_pr', job => this.handleProcessJob(job));
    this.queue.registerHandler('run_command', job => this.handleRunCommandJob(job));
    this.registerWebhookHandlers();
    this.queue.start(1500);

    // Register cleanup for graceful shutdown
    this.registerCleanup();
  }
  
  private registerCleanup(): void {
    if (this.cleanupRegistered) return;
    
    const cleanupId = 'pr-autopilot-agent';
    
    // Register cleanup for GitOps
    registerCleanup(cleanupId, () => {
      console.log('[CLEANUP] Cleaning up GitOps resources...');
      this.gitOps.cleanup();
    });
    
    // Register cleanup for PatchGenerator
    registerCleanup(cleanupId, () => {
      console.log('[CLEANUP] Cleaning up PatchGenerator resources...');
      this.patchGenerator.cleanup();
    });
    
    // Register cleanup for queue
    registerCleanup(cleanupId, () => {
      console.log('[CLEANUP] Stopping queue processor...');
      this.queue.stop();
    });
    
    // Handle process signals
    process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));
    process.on('SIGUSR2', () => this.gracefulShutdown('SIGUSR2')); // nodemon restart
    
    this.cleanupRegistered = true;
  }
  
  private async gracefulShutdown(signal: string): Promise<void> {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    
    // Stop accepting new requests
    try {
      await this.fastify.close();
      console.log('Server closed');
    } catch (err) {
      console.error('Error closing server:', err);
    }
    
    // Run all registered cleanup functions
    runAllCleanup();
    
    console.log('Cleanup completed, exiting...');
    process.exit(0);
  }

  async start(): Promise<void> {
    this.fastify.get('/health', async (request, reply) => {
      const queueStatus = this.queue.getStatus();
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        queue: {
          length: queueStatus.queueLength,
          processing: queueStatus.processingCount,
          jobs: queueStatus.jobs.map(j => ({ id: j.id, type: j.type, repo: j.repo, pr: j.pr }))
        },
        handlersRegistered: true
      };
    });

    // Approval management endpoints
    this.fastify.get('/approvals', async (request, reply) => {
      const { repo, pr, status } = request.query as { repo?: string; pr?: string; status?: string };
      
      let approvals = this.approvalManager.listApprovals(status as any);
      
      if (repo) {
        approvals = approvals.filter(a => a.repo === repo);
        if (pr) {
          approvals = approvals.filter(a => a.pr === parseInt(pr));
        }
      }
      
      return {
        count: approvals.length,
        approvals
      };
    });

    this.fastify.get('/approvals/pending', async (request, reply) => {
      const { repo, pr } = request.query as { repo?: string; pr?: string };
      
      let pending = this.approvalManager.getPendingApprovals(repo || '');
      
      if (pr) {
        pending = pending.filter(a => a.pr === parseInt(pr));
      }
      
      return {
        count: pending.length,
        pending
      };
    });

    this.fastify.get('/approvals/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const approval = this.approvalManager.getApproval(id);
      
      if (!approval) {
        return reply.code(404).send({ error: 'Approval not found' });
      }
      
      return approval;
    });

    this.fastify.post('/approvals/:id/approve', async (request, reply) => {
      const { id } = request.params as { id: string };
      const { user } = request.body as { user: string };
      
      if (!user) {
        return reply.code(400).send({ error: 'user is required' });
      }
      
      const approval = this.approvalManager.getApproval(id);
      if (!approval) {
        return reply.code(404).send({ error: 'Approval not found' });
      }
      
      const success = await this.approvalManager.approve(approval.repo, approval.pr, id, user);
      
      if (success) {
        return { success: true, message: 'Approval granted' };
      } else {
        return reply.code(400).send({ error: 'Approval already processed' });
      }
    });

    this.fastify.post('/approvals/:id/reject', async (request, reply) => {
      const { id } = request.params as { id: string };
      const { user, reason } = request.body as { user: string; reason?: string };
      
      if (!user) {
        return reply.code(400).send({ error: 'user is required' });
      }
      
      const approval = this.approvalManager.getApproval(id);
      if (!approval) {
        return reply.code(404).send({ error: 'Approval not found' });
      }
      
      const success = await this.approvalManager.reject(approval.repo, approval.pr, id, user, reason);
      
      if (success) {
        return { success: true, message: 'Approval rejected' };
      } else {
        return reply.code(400).send({ error: 'Approval already processed' });
      }
    });

    this.fastify.get('/approvals/report', async (request, reply) => {
      const report = this.approvalManager.generateReport();
      reply.type('text/markdown');
      return report;
    });

    // Register cleanup for graceful shutdown
    if (!this.cleanupRegistered) {
      this.registerCleanup();
    }

    this.fastify.post('/webhook', { config: { rawBody: true } }, async (request, reply) => {
      const deliveryId = request.headers['x-github-delivery'] as string;
      const eventName = request.headers['x-github-event'] as string;
      const signature = request.headers['x-hub-signature-256'] as string;
      const webhookSource = request.headers['x-webhook-source'] as string;
      
      // LOG: Webhook received
      c.webhook(`Received: event=${eventName}, delivery=${deliveryId}, source=${webhookSource || 'direct'}`);
      
      // Check if rawBody is available
      const rawBody = (request.rawBody as string) || (request.body ? JSON.stringify(request.body) : '');
      
      if (!rawBody) {
        this.fastify.log.error('No rawBody or body available in request');
        reply.code(400).send({ error: 'No body in request' });
        return;
      }

      // Skip verification for webhooks from our own queue (already trusted)
      if (webhookSource === 'pr-autopilot-queue') {
        this.fastify.log.info('Webhook from queue, skipping signature verification');
        try {
          const parsedPayload = JSON.parse(rawBody);
          c.webhook(`Processing queue webhook: event=${eventName}, action=${parsedPayload.action}`);
          await this.webhooks.receive({
            id: deliveryId,
            name: eventName as any,
            payload: parsedPayload
          });
          c.success(`Queue webhook processed successfully`);
          reply.send({ ok: true });
        } catch (error: any) {
          c.error(`Error processing queue webhook: ${error.message}`);
          reply.code(500).send({ error: error.message });
        }
        return;
      }

      if (!WEBHOOK_SECRET) {
        this.fastify.log.warn('No WEBHOOK_SECRET configured, skipping verification');
        reply.send({ ok: true });
        return;
      }

      // Skip verification for test signatures during development
      if (signature === 'sha256=fake_signature_for_testing') {
        this.fastify.log.warn('Using fake test signature, skipping verification');
        reply.send({ ok: true });
        return;
      }

      try {
        // Debug logging for verification troubleshooting
        this.fastify.log.info({
          msg: 'Webhook verification debug',
          deliveryId,
          eventName,
          hasSignature: !!signature,
          signaturePrefix: signature?.slice(0, 20),
          rawBodyLength: rawBody.length,
          rawBodyStart: rawBody.slice(0, 100),
          rawBodyEnd: rawBody.slice(-100),
          secretConfigured: !!WEBHOOK_SECRET,
          secretLength: WEBHOOK_SECRET?.length
        });

        // First verify the signature with the raw body
        const isValid = await this.webhooks.verify(rawBody, signature);
        
        this.fastify.log.info({ msg: 'Signature verification result', isValid });
        
        if (!isValid) {
          throw new Error('Invalid signature');
        }

        // After verification succeeds, parse and receive the payload
        const parsedPayload = JSON.parse(rawBody);
        c.webhook(`Processing verified webhook: event=${eventName}, action=${parsedPayload.action}`);
        await this.webhooks.receive({
          id: deliveryId,
          name: eventName as any,
          payload: parsedPayload
        });
        c.success(`Verified webhook processed successfully`);
        
        reply.send({ ok: true });
      } catch (error: any) {
        this.fastify.log.error({
          msg: 'Webhook verification failed',
          errorMessage: error?.message,
          errorStack: error?.stack,
          deliveryId,
          eventName,
          hasSignature: !!signature,
          rawBodyLength: rawBody.length
        });
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
      c.handler(`pull_request_review_comment triggered: action=${context.payload.action}`);
      try {
        if (context.payload.action !== 'created') {
          c.handler(`Skipping: action is '${context.payload.action}', expected 'created'`);
          return;
        }
        const repoFull = context.payload.repository?.full_name;
        const prNumber = context.payload.pull_request?.number;
        c.handler(`Parsing inline comment for ${repoFull}#${prNumber}`);
        const comment = this.parser.parseInlineComment(context.payload);
        c.handler(`Parsed comment: ${comment ? JSON.stringify({ id: comment.id, type: comment.type, file: comment.file }) : null}`);
        if (repoFull && prNumber && comment) {
          await this.handleCommentEvent(repoFull, prNumber, [comment]);
        } else {
          c.handler(`Skipping: missing repoFull=${!!repoFull}, prNumber=${!!prNumber}, comment=${!!comment}`);
        }
      } catch (error: any) {
        c.error(`Error in pull_request_review_comment handler: ${error.message}`);
      }
    });

    this.webhooks.on('pull_request_review', async (context: any) => {
      c.handler(`pull_request_review triggered: action=${context.payload.action}`);
      try {
        if (context.payload.action !== 'submitted') {
          c.handler(`Skipping: action is '${context.payload.action}', expected 'submitted'`);
          return;
        }
        const repoFull = context.payload.repository?.full_name;
        const prNumber = context.payload.pull_request?.number;
        c.handler(`Parsing review for ${repoFull}#${prNumber}`);
        const comments = this.parser.parseReview(context.payload);
        c.handler(`Parsed ${comments.length} comments from review`);
        if (repoFull && prNumber) {
          await this.handleCommentEvent(repoFull, prNumber, comments);
        } else {
          c.handler(`Skipping: missing repoFull=${!!repoFull}, prNumber=${!!prNumber}`);
        }
      } catch (error: any) {
        c.error(`Error in pull_request_review handler: ${error.message}`);
      }
    });

    this.webhooks.on('issue_comment', async (context: any) => {
      c.handler(`issue_comment triggered: action=${context.payload.action}`);
      try {
        if (context.payload.issue.pull_request) {
          const repoFull = context.payload.repository?.full_name;
          const prNumber = context.payload.issue.number;
          const commentAuthor = context.payload.comment?.user?.login || 'unknown';
          c.handler(`Processing issue comment for PR ${repoFull}#${prNumber} by ${commentAuthor}`);
          if (repoFull) {
            await this.handleIssueComment(repoFull, prNumber, context.payload.comment.body, commentAuthor);
          }
        } else {
          c.handler(`Skipping: not a PR comment`);
        }
      } catch (error: any) {
        c.error(`Error in issue_comment handler: ${error.message}`);
      }
    });

    this.webhooks.on('pull_request', async (context: any) => {
      c.handler(`pull_request triggered: action=${context.payload.action}`);
      try {
        const repoFull = context.payload.repository?.full_name;
        if (repoFull && ['opened', 'reopened', 'synchronize'].includes(context.payload.action)) {
          c.handler(`Resetting state for ${repoFull}#${context.payload.number}`);
          this.stateMachine.resetState(repoFull, context.payload.number);
        } else {
          c.handler(`Skipping: action '${context.payload.action}' not in handled list`);
        }
      } catch (error: any) {
        c.error(`Error in pull_request handler: ${error.message}`);
      }
    });

    this.webhooks.on('check_run', async (context: any) => {
      c.handler(`check_run triggered: action=${context.payload.action}, status=${context.payload.check_run.status}, conclusion=${context.payload.check_run.conclusion}`);
      try {
        const repoFull = context.payload.repository?.full_name;
        const prs = context.payload.check_run.pull_requests;
        if (repoFull && prs && prs.length > 0 && context.payload.check_run.status === 'completed' && context.payload.check_run.conclusion === 'failure') {
          for (const pr of prs) {
            c.handler(`Check failed for ${repoFull}#${pr.number}, triggering analysis`);
            // Here we could trigger a special job to analyze failures and fix them
            // For now, just log it.
          }
        }
      } catch (error: any) {
        c.error(`Error in check_run handler: ${error.message}`);
      }
    });

    this.webhooks.on('workflow_run', async (context: any) => {
      c.handler(`workflow_run triggered: action=${context.payload.action}, status=${context.payload.workflow_run.status}, conclusion=${context.payload.workflow_run.conclusion}`);
      try {
        const repoFull = context.payload.repository?.full_name;
        const prs = context.payload.workflow_run.pull_requests;
        if (repoFull && prs && prs.length > 0 && context.payload.workflow_run.status === 'completed' && context.payload.workflow_run.conclusion === 'failure') {
          for (const pr of prs) {
            c.handler(`Workflow failed for ${repoFull}#${pr.number}`);
          }
        }
      } catch (error: any) {
        c.error(`Error in workflow_run handler: ${error.message}`);
      }
    });

    c.success(`Webhook handlers registered`);
  }

  private async handleCommentEvent(repofull: string, pr: number, comments: (ParsedReviewComment | null)[]): Promise<void> {
    c.comment(`Handling ${comments.length} comments for ${repofull}#${pr}`);
    const cleanedComments = comments.filter(Boolean) as ParsedReviewComment[];
    c.comment(`${cleanedComments.length} comments after filtering nulls`);
    
    if (!cleanedComments.length) {
      c.comment(`No valid comments to process, returning`);
      return;
    }

    // Track all received comments
    const trackedComments = this.commentTracker.addComments(repofull, pr, cleanedComments);
    c.comment(`Tracked ${trackedComments.length} comments for ${repofull}#${pr}`);

    const { owner, repo } = this.splitRepo(repofull);
    c.comment(`Loading config for ${owner}/${repo}`);
    const config = await this.configLoader.loadConfig(owner, repo);
    c.comment(`Config loaded: autofix.enabled=${config.autofix.enabled}, risk_level=${config.autofix.risk_level}`);

    const runnable = this.parser.filterComments(cleanedComments, config);
    c.comment(`${runnable.length}/${cleanedComments.length} comments are runnable after config filtering`);
    
    if (runnable.length > 0) {
      // Mark runnable comments as queued
      this.commentTracker.markQueued(repofull, pr, runnable.map(c => c.id));
<<<<<<< HEAD

=======
      for (const comment of cleanedComments) {
        if (!runnable.some(r => r.id === comment.id)) {
          this.commentTracker.updateStatus(repofull, pr, comment.id, 'skipped');
        }
      }
      
>>>>>>> origin/autopilot/pr-2-fixes
      this.stateMachine.addPendingComments(repofull, pr, runnable);

      // Check if a job for this PR is already in the queue
      const status = this.queue.getStatus();
      const alreadyQueued = status.jobs.some(j => j.type === 'process_pr' && j.repo === repofull && j.pr === pr);

      if (!alreadyQueued) {
        c.comment(`Queueing batch job for ${repofull}#${pr}`);
        this.queue.addJob('process_pr', repofull, pr, { config }, 0);
      } else {
        c.comment(`Batch job already queued for ${repofull}#${pr}, comments added to pending list`);
      }
      
      // FIX: Mark non-runnable comments as skipped (even when some are runnable)
      const nonRunnable = cleanedComments.filter(c => !runnable.some(r => r.id === c.id));
      for (const comment of nonRunnable) {
        this.commentTracker.updateStatus(repofull, pr, comment.id, 'skipped');
      }
    } else {
      // Mark non-runnable comments as skipped
      for (const comment of cleanedComments) {
        this.commentTracker.updateStatus(repofull, pr, comment.id, 'skipped');
      }
    }
  }

  private async handleIssueComment(repofull: string, pr: number, body: string, commentAuthor?: string): Promise<void> {
    const trimmedBody = body.trim();
    c.comment(`Handling command in ${repofull}#${pr}: ${trimmedBody.slice(0, 50)}...`);

    if (trimmedBody.startsWith('/stop-autofix')) {
      c.comment(`Stop command detected, blocking PR`);
      this.stateMachine.transition(repofull, pr, 'BLOCKED', 'Manual stop command received');
      await this.octokit.rest.issues.createComment({
        owner: this.splitRepo(repofull).owner,
        repo: this.splitRepo(repofull).repo,
        issue_number: pr,
        body: 'Auto-fixes halted for this PR. Remove `/stop-autofix` to resume.',
      });
    } else if (trimmedBody.startsWith('/autopilot run ')) {
      const commandToRun = trimmedBody.replace('/autopilot run ', '').trim();
      if (commandToRun) {
        c.comment(`Manual command requested: ${commandToRun}`);
        const config = await this.configLoader.loadConfig(this.splitRepo(repofull).owner, this.splitRepo(repofull).repo);
        this.queue.addJob('run_command', repofull, pr, { command: commandToRun, config }, 10);

        await this.octokit.rest.issues.createComment({
          owner: this.splitRepo(repofull).owner,
          repo: this.splitRepo(repofull).repo,
          issue_number: pr,
          body: `🚀 Queued manual command: \`${commandToRun}\``,
        });
      }
    } else if (trimmedBody.startsWith('/pr-autopilot approve ')) {
      // Handle approval command
      const approvalId = trimmedBody.replace('/pr-autopilot approve ', '').trim().split(' ')[0];
      if (approvalId) {
        c.comment(`Approval command detected: ${approvalId}`);
        await this.handleApprovalCommand(repofull, pr, approvalId, commentAuthor || 'unknown', 'approve');
      }
    } else if (trimmedBody.startsWith('/pr-autopilot reject ')) {
      // Handle rejection command
      const parts = trimmedBody.replace('/pr-autopilot reject ', '').trim().split(' ');
      const approvalId = parts[0];
      const reason = parts.slice(1).join(' ') || 'No reason provided';
      
      if (approvalId) {
        c.comment(`Rejection command detected: ${approvalId}`);
        await this.handleApprovalCommand(repofull, pr, approvalId, commentAuthor || 'unknown', 'reject', reason);
      }
    } else if (trimmedBody === '/pr-autopilot approvals' || trimmedBody === '/pr-autopilot pending') {
      // List pending approvals
      await this.handleListApprovalsCommand(repofull, pr);
    } else if (trimmedBody.startsWith('/pr-autopilot approval ')) {
      // Show approval details
      const approvalId = trimmedBody.replace('/pr-autopilot approval ', '').trim();
      if (approvalId) {
        await this.handleApprovalDetailsCommand(repofull, pr, approvalId);
      }
    }
  }

  /**
   * Handle approval/rejection command
   */
  private async handleApprovalCommand(
    repo: string,
    pr: number,
    approvalId: string,
    user: string,
    action: 'approve' | 'reject',
    reason?: string
  ): Promise<void> {
    const { owner, repo: repoName } = this.splitRepo(repo);
    
    // Check if user can approve
    const canApprove = await this.approvalManager.canUserApprove(repo, user, pr);
    
    if (!canApprove) {
      await this.octokit.rest.issues.createComment({
        owner,
        repo: repoName,
        issue_number: pr,
        body: `❌ **Permission Denied**\n\n@${user} you don't have permission to approve patches for this repository.\n\nOnly repository owners, admins, or users with push/maintain access can approve patches.`
      });
      return;
    }

    // Get approval
    const approval = this.approvalManager.getApproval(approvalId);
    
    if (!approval) {
      await this.octokit.rest.issues.createComment({
        owner,
        repo: repoName,
        issue_number: pr,
        body: `❌ **Approval Not Found**\n\nApproval ID \`${approvalId}\` not found.\n\nUse \`/pr-autopilot approvals\` to see pending approvals.`
      });
      return;
    }

    if (approval.repo !== repo || approval.pr !== pr) {
      await this.octokit.rest.issues.createComment({
        owner,
        repo: repoName,
        issue_number: pr,
        body: `❌ **Invalid PR**\n\nThis approval is for a different PR (${approval.repo}#${approval.pr}).`
      });
      return;
    }

    // Process approval/rejection
    let success: boolean;
    if (action === 'approve') {
      success = await this.approvalManager.approve(repo, pr, approvalId, user);
    } else {
      success = await this.approvalManager.reject(repo, pr, approvalId, user, reason);
    }

    if (success) {
      // If approved, add comment to pending comments for reprocessing
      if (action === 'approve') {
        const { ParsedReviewComment } = await import('./types');
        const comment: ParsedReviewComment = {
          id: approval.commentId,
          file: approval.file,
          start_line: approval.startLine,
          end_line: approval.endLine,
          type: 'suggested_change',
          content: 'Approved patch',
          author: user,
          commit_sha: ''
        };

        // FIX: Clear the processed flag before re-adding, otherwise addPendingComments will skip it
        this.stateMachine.unmarkCommentProcessed(repo, pr, comment.id);
        this.stateMachine.addPendingComments(repo, pr, [comment]);

        // Queue a job to process the approved patch
        const config = await this.configLoader.loadConfig(owner, repoName);
        this.queue.addJob('process_pr', repo, pr, { config }, 10);

        c.success(`Approval ${approvalId} processed, patch will be applied`);
      } else {
        c.success(`Rejection ${approvalId} processed, patch discarded`);
      }
    } else {
      await this.octokit.rest.issues.createComment({
        owner,
        repo: repoName,
        issue_number: pr,
        body: `⚠️ **Approval Already Processed**\n\nThis approval has already been ${approval.status}.`
      });
    }
  }

  /**
   * List pending approvals command
   */
  private async handleListApprovalsCommand(repo: string, pr: number): Promise<void> {
    const { owner, repo: repoName } = this.splitRepo(repo);
    const pending = this.approvalManager.getPendingApprovals(repo, pr);

    if (pending.length === 0) {
      await this.octokit.rest.issues.createComment({
        owner,
        repo: repoName,
        issue_number: pr,
        body: `✅ **No Pending Approvals**\n\nAll patches for this PR have been processed.`
      });
      return;
    }

    let body = `📋 **Pending Approvals** (${pending.length})\n\n`;
    body += '| ID | File | Lines | Reason | Created |\n';
    body += '|---|---|---|---|---|\n';
    
    for (const approval of pending) {
      const created = new Date(approval.createdAt).toLocaleString();
      body += `| \`${approval.id.substring(0, 20)}...\` | ${approval.file} | ${approval.startLine}-${approval.endLine} | ${approval.reason} | ${created} |\n`;
    }

    body += '\n---\n\n';
    body += '**Commands:**\n';
    body += '- Approve: `/pr-autopilot approve <ID>`\n';
    body += '- Reject: `/pr-autopilot reject <ID> [reason]`\n';
    body += '- Details: `/pr-autopilot approval <ID>`';

    await this.octokit.rest.issues.createComment({
      owner,
      repo: repoName,
      issue_number: pr,
      body
    });
  }

  /**
   * Show approval details command
   */
  private async handleApprovalDetailsCommand(repo: string, pr: number, approvalId: string): Promise<void> {
    const { owner, repo: repoName } = this.splitRepo(repo);
    const approval = this.approvalManager.getApproval(approvalId);

    if (!approval) {
      await this.octokit.rest.issues.createComment({
        owner,
        repo: repoName,
        issue_number: pr,
        body: `❌ **Approval Not Found**\n\nApproval ID \`${approvalId}\` not found.`
      });
      return;
    }

    let body = `📄 **Approval Details**\n\n`;
    body += `**ID**: \`${approval.id}\`\n`;
    body += `**File**: \`${approval.file}:${approval.startLine}-${approval.endLine}\`\n`;
    body += `**Status**: ${approval.status}\n`;
    body += `**Reason**: ${approval.reason}\n`;
    body += `**Created**: ${new Date(approval.createdAt).toLocaleString()}\n`;
    
    if (approval.approvedBy) {
      body += `**${approval.status === 'approved' ? 'Approved' : 'Rejected'} by**: @${approval.approvedBy}\n`;
      body += `**${approval.status === 'approved' ? 'Approved' : 'Rejected'} at**: ${new Date(approval.approvedAt!).toLocaleString()}\n`;
    }
    
    if (approval.reviewComment) {
      body += `**Comment**: ${approval.reviewComment}\n`;
    }

    body += '\n---\n\n';
    body += '**Patch:**\n\n';
    body += '```diff\n';
    body += approval.patch.substring(0, 2000);
    if (approval.patch.length > 2000) {
      body += '\n... (truncated)';
    }
    body += '\n```';

    await this.octokit.rest.issues.createComment({
      owner,
      repo: repoName,
      issue_number: pr,
      body
    });
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

  private async handleRunCommandJob(job: Job): Promise<JobResult> {
    const { owner, repo } = this.splitRepo(job.repo);
    const data = job.data;

    try {
      c.job(`Running manual command for ${job.repo}#${job.pr}: ${data.command}`);

      const pr = await this.octokit.rest.pulls.get({ owner, repo, pull_number: job.pr });
      const headRef = pr.data.head.ref;

      await this.gitOps.clone(job.repo);

      const helperBranch = this.stateMachine.getHelperBranch(job.repo, job.pr);
      const targetBranch = helperBranch || headRef;

      await this.gitOps.checkout(job.repo, targetBranch);

      const result = await this.gitOps.runCommand(job.repo, data.command);

      const statusIcon = result.success ? '✅' : '❌';
      const output = result.output.trim();
      const formattedOutput = output ? `\n\`\`\`\n${output.slice(0, 1500)}${output.length > 1500 ? '...' : ''}\n\`\`\`` : '_No output_';

      await this.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: job.pr,
        body: `### ${statusIcon} Command Result: \`${data.command}\`\n${formattedOutput}`,
      });

      return { success: true };
    } catch (error: any) {
      c.error(`Manual command job failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Post approval request comment to PR
   */
  private async postApprovalRequest(
    repo: string,
    pr: number,
    comment: ParsedReviewComment,
    approval: any,
    reason?: string
  ): Promise<void> {
    const { owner, repo: repoName } = this.splitRepo(repo);
    
    const reasonText = reason ? ` (${reason})` : '';
    
    let body = `⚠️ **Patch Requires Approval**\n\n`;
    body += `**File**: \`${comment.file}:${comment.start_line}-${comment.end_line}\`\n`;
    body += `**Reason**: ${reason || 'Manual review required'}\n`;
    body += `**Approval ID**: \`${approval.id}\`\n\n`;
    body += `---\n\n`;
    body += `**To approve**, comment:\n`;
    body += `\`\`\`\n/pr-autopilot approve ${approval.id}\n\`\`\`\n\n`;
    body += `**To reject**, comment:\n`;
    body += `\`\`\`\n/pr-autopilot reject ${approval.id} [your reason]\n\`\`\`\n\n`;
    body += `---\n\n`;
    body += `<details>\n<summary>📄 View Patch</summary>\n\n\`\`\`diff\n${approval.patch}\n\`\`\`\n\n</details>`;

    await this.octokit.rest.issues.createComment({
      owner,
      repo: repoName,
      issue_number: pr,
      body
    });
    
    console.log(`[APPROVAL] Posted approval request ${approval.id} to ${repo}#${pr}`);
  }

  private async handleProcessJob(job: Job): Promise<JobResult> {
    console.log(`[JOB] Processing job ${job.id} for ${job.repo}#${job.pr}`);
    const data = job.data as ProcessJobData;
    const { owner, repo } = this.splitRepo(job.repo);

    // Initialize arrays before try block so they're accessible in catch
    const appliedComments: ParsedReviewComment[] = [];
    const rejectedComments: { comment: ParsedReviewComment; error: string }[] = [];
    const needsApprovalComments: ParsedReviewComment[] = [];

    try {
      // FIRST: Try to get pending comments from state machine
      let pendingComments = this.stateMachine.getAndClearPendingComments(job.repo, job.pr);
      
      // FALLBACK: If state machine has no pending comments, get from CommentTracker
      // This handles cases where state wasn't properly persisted
      if (pendingComments.length === 0) {
        console.log(`[JOB] State machine has no pending comments, checking CommentTracker...`);
        const trackedComments = this.commentTracker.getPendingComments(job.repo, job.pr);
        
        if (trackedComments.length > 0) {
          console.log(`[JOB] Found ${trackedComments.length} pending comments in CommentTracker`);
          // Convert TrackedComment to ParsedReviewComment
          pendingComments = trackedComments.map(tc => ({
            id: tc.id,
            file: tc.file,
            start_line: tc.start_line,
            end_line: tc.end_line,
            type: tc.type,
            content: tc.content,
            suggestions: tc.suggestions,
            proposed_fixes: tc.proposed_fixes,
            agent_prompt: tc.agent_prompt,
            author: tc.author,
            bot_name: tc.bot_name,
            commit_sha: tc.commit_sha || '',
            diff_hunk: tc.diff_hunk,
            url: tc.url,
          }));
          
          // Mark these comments as processing in tracker
          this.commentTracker.markQueued(job.repo, job.pr, pendingComments.map(c => c.id));
        } else {
          console.log(`[JOB] No pending comments found in CommentTracker either`);
        }
      } else {
        console.log(`[JOB] Found ${pendingComments.length} pending comments from state machine`);
      }
      
      if (pendingComments.length === 0) {
        console.log(`[JOB] No pending comments for ${job.repo}#${job.pr}, skipping`);
        return { success: true };
      }

      console.log(`[JOB] Processing ${pendingComments.length} pending comments for ${job.repo}#${job.pr}`);
      
      // Mark all pending comments as processing in tracker
      for (const comment of pendingComments) {
        this.commentTracker.updateStatus(job.repo, job.pr, comment.id, 'processing');
      }
      
      // Check if this is a retry after a failure
      const currentState = this.stateMachine.getState(job.repo, job.pr);
      const isRetryAfterFailure = currentState.state === 'FAILED';
      
      this.stateMachine.transition(job.repo, job.pr, 'FIXING');

      // 2. Setup repo and branch
      console.log(`[JOB] Fetching PR data for ${owner}/${repo}#${job.pr}`);
      const pr = await this.octokit.rest.pulls.get({ owner, repo, pull_number: job.pr });
      const headRef = pr.data.head.ref;

      console.log(`[JOB] Cloning repo ${job.repo}`);
      await this.gitOps.clone(job.repo);

      let targetBranch: string;
      const isAlreadyAutopilotBranch = /^autopilot\/pr-\d+/.test(headRef);
      if (isAlreadyAutopilotBranch) {
        // PR head is already an autopilot branch — commit directly to it
        console.log(`[JOB] PR head '${headRef}' is an autopilot branch, committing directly to it`);
        targetBranch = headRef;
      } else if (data.config.autofix.branch_strategy === 'helper_pr') {
        const existingHelperBranch = this.stateMachine.getHelperBranch(job.repo, job.pr);
        
        // If this is a retry after failure, we should create a fresh helper branch
        if (isRetryAfterFailure && existingHelperBranch) {
          console.log(`[JOB] Retrying after failure, creating fresh helper branch from ${headRef}`);
          // Delete the old helper branch reference and create a new one
          this.stateMachine.setHelperBranch(job.repo, job.pr, undefined);
          targetBranch = await this.gitOps.getOrCreateHelperBranch(job.repo, job.pr, headRef, undefined);
          this.stateMachine.setHelperBranch(job.repo, job.pr, targetBranch);
        } else {
          targetBranch = await this.gitOps.getOrCreateHelperBranch(job.repo, job.pr, headRef, existingHelperBranch);
          if (!existingHelperBranch) {
            this.stateMachine.setHelperBranch(job.repo, job.pr, targetBranch);
          }
        }
      } else {
        targetBranch = headRef;
      }

      console.log(`[JOB] Checking out branch ${targetBranch}`);
      await this.gitOps.checkout(job.repo, targetBranch);
      const currentHeadSha = await this.gitOps.getCurrentCommit(job.repo);

      // 3. Process each comment
      for (const comment of pendingComments) {
        if (!comment.file) continue;

        // Mark comment as processing
        this.commentTracker.updateStatus(job.repo, job.pr, comment.id, 'processing');

        const level = this.determineAutomationLevel(comment, data.config);
        console.log(`[JOB] Generating patch for ${comment.file} (level ${level})`);
        
        const patchRequest: PatchRequest = {
          repo: job.repo,
          pr: job.pr,
          commit_sha: currentHeadSha,
          file: comment.file,
          start_line: comment.start_line,
          end_line: comment.end_line,
          content: comment.content,
          context: comment.diff_hunk,
          diff_hunk: comment.diff_hunk,
          suggestions: comment.suggestions,
          proposed_fixes: comment.proposed_fixes,
          agent_prompt: comment.agent_prompt,
        };

        const patchResult = await this.patchGenerator.generatePatch(
          patchRequest, 
          level, 
          data.config.autofix.use_cli_tools
        );

        if (!patchResult.success || !patchResult.patch) {
          console.log(`[JOB] Patch generation failed for ${comment.id}: ${patchResult.error}`);
          rejectedComments.push({ comment, error: patchResult.error || 'Patch generation failed' });
          this.commentTracker.updateStatus(job.repo, job.pr, comment.id, 'failed', { error: patchResult.error });
          continue;
        }

        // Mark patch generated
        this.commentTracker.updateStatus(job.repo, job.pr, comment.id, 'patch_generated', { patch: patchResult.patch?.substring(0, 500) });

        // Check if patch requires approval using ApprovalManager
        const approvalCheck = this.approvalManager.requiresApproval(
          comment.file,
          patchResult.patch,
          comment.content,
          data.config.autofix.risk_level
        );

        if (patchResult.requires_approval || approvalCheck.requires) {
          console.log(`[JOB] Patch for ${comment.id} requires approval: ${approvalCheck.reason || 'manual'}`);
          
          // Add to pending approvals
          const approval = this.approvalManager.addPendingApproval(
            job.repo,
            job.pr,
            comment.id,
            comment.file,
            comment.start_line,
            comment.end_line,
            patchResult.patch,
            approvalCheck.reason || 'manual_flag'
          );

          needsApprovalComments.push(comment);

          // Post detailed approval request comment
          await this.postApprovalRequest(job.repo, job.pr, comment, approval, approvalCheck.reason);
          continue;
        }

        try {
          console.log(`[JOB] Applying patch for ${comment.id}`);
          await this.gitOps.applyPatch(job.repo, patchResult.patch);
          appliedComments.push(comment);
        } catch (error: any) {
          console.log(`[JOB] Failed to apply patch for ${comment.id}: ${error.message}`);
          rejectedComments.push({ comment, error: `Failed to apply patch: ${error.message}` });
          this.commentTracker.updateStatus(job.repo, job.pr, comment.id, 'failed', { error: error.message });
        }
      }

      // 4. Format files if enabled
      if (appliedComments.length > 0 && data.config.autofix.format_after_fix) {
        console.log(`[JOB] Formatting ${appliedComments.length} files`);
        const uniqueFiles = [...new Set(appliedComments.map(c => c.file))];
        for (const file of uniqueFiles) {
          await this.gitOps.formatFile(job.repo, file);
        }
      }

      // 5. Run Workflows if enabled
      let workflowFailed = false;
      const workflowResults: { name: string; success: boolean; output: string }[] = [];
      
      if (appliedComments.length > 0 && data.config.workflows?.enabled) {
        console.log(`[JOB] Running workflows for ${job.repo}#${job.pr}`);
        for (const step of data.config.workflows.steps) {
          console.log(`[JOB] Step: ${step.name} (${step.type})`);
          if (step.type === 'command' || step.type === 'test' || step.type === 'lint') {
            if (step.command) {
              const result = await this.gitOps.runCommand(job.repo, step.command, {
                env: step.env,
                timeout: step.timeout_ms,
                cwd: step.working_dir
              });
              
              workflowResults.push({ name: step.name, success: result.success, output: result.output });
              
              if (!result.success) {
                console.log(`[JOB] Step ${step.name} failed: ${result.output}`);
                if (!step.allow_failure) {
                  workflowFailed = true;
                  
                  await this.octokit.rest.issues.createComment({
                    owner,
                    repo,
                    issue_number: job.pr,
                    body: `### ❌ Workflow step "${step.name}" failed\nApplied changes were rolled back due to failure:\n\`\`\`\n${result.output.slice(0, 1000)}\n\`\`\``,
                  });
                  break;
                }
              }
            }
          }
        }
      }

      // 5. Commit and Push
      if (appliedComments.length > 0 && !workflowFailed) {
        c.commit(`Committing changes for ${appliedComments.length} comments`);
        const commitMsg = `chore(pr-${job.pr}): fix multiple issues\n\nFixed comments:\n` +
          appliedComments.map(c => `- ${c.file}:${c.start_line} (${c.id})`).join('\n');

        const commitSha = await this.gitOps.commit(job.repo, commitMsg);
        c.commit(`Committed as ${commitSha}`);

        try {
          await this.gitOps.push(job.repo, targetBranch);

          let body = `### ✅ Successfully applied fixes for ${appliedComments.length} issues\n\n`;
          body += `**Fixed items:**\n` + appliedComments.map(c => {
            const fileLine = `${c.file}:${c.start_line}`;
            if (c.url) {
              return `- [${fileLine}](${c.url})`;
            }
            return `- ${fileLine}`;
          }).join('\n');

          if (workflowResults.length > 0) {
            body += `\n\n**Workflow results:**\n` + workflowResults.map(r => `${r.success ? '✅' : '❌'} ${r.name}`).join('\n');
          }

          body += `\n\nRe-running CI checks on commit \`${commitSha.slice(0, 7)}\`.`;

          await this.octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: job.pr,
            body,
          });

          this.stateMachine.incrementIteration(job.repo, job.pr);
          for (const c of appliedComments) {
            this.stateMachine.markCommentProcessed(job.repo, job.pr, c.id);
            // Mark comment as committed in tracker
            this.commentTracker.updateStatus(job.repo, job.pr, c.id, 'committed', { commit_sha: commitSha });
          }
          this.stateMachine.transition(job.repo, job.pr, 'PUSHED');
        } catch (pushError: any) {
          console.error(`[JOB] Push failed: ${pushError.message}`);
          
          // Restore the applied comments to pending state so they can be retried
          this.stateMachine.addPendingComments(job.repo, job.pr, appliedComments);
          
          // Also add back any comments that were marked as processed but not yet applied
          const allPendingComments = [...appliedComments, ...needsApprovalComments];
          for (const c of allPendingComments) {
            this.stateMachine.unmarkCommentProcessed(job.repo, job.pr, c.id);
          }
          
          throw new Error(`Push failed: ${pushError.message}`);
        }
      } else if (workflowFailed) {
        console.log(`[JOB] Workflow failed, not committing`);
        // We should ideally reset the git state here, but since we re-clone/re-checkout every time,
        // it's not strictly necessary for the next job. But for this job, we're done.
        this.stateMachine.transition(job.repo, job.pr, 'FAILED', 'Workflow failed');
      }

      // Handle rejected or needs approval comments by marking them processed so we don't loop
      // (or maybe don't mark them processed if we want to retry?)
      // Actually, if it needs approval, we shouldn't mark it "processed" in the sense that it's DONE,
      // but we should avoid picking it up in the next AUTO-fix batch until approved.
      // For now, let's mark them as processed to avoid loops.
      for (const c of needsApprovalComments) {
        this.stateMachine.markCommentProcessed(job.repo, job.pr, c.id);
      }
      for (const { comment: c } of rejectedComments) {
        this.stateMachine.markCommentProcessed(job.repo, job.pr, c.id);
      }

      console.log(`[JOB] Job ${job.id} completed successfully`);
      return { success: true };
    } catch (error: any) {
      console.error(`[JOB] Job ${job.id} failed:`, error.message);
      this.stateMachine.transition(job.repo, job.pr, 'FAILED', error.message);
      
      // If the job failed, we should NOT mark the comments as processed, so they can be retried
      // Restore the applied comments to pending state so they can be retried
      if (appliedComments.length > 0) {
        this.stateMachine.addPendingComments(job.repo, job.pr, appliedComments);
        for (const c of appliedComments) {
          this.stateMachine.unmarkCommentProcessed(job.repo, job.pr, c.id);
        }
      }
      
      // Also restore rejected and needs approval comments if they were marked as processed
      for (const c of needsApprovalComments) {
        this.stateMachine.unmarkCommentProcessed(job.repo, job.pr, c.id);
      }
      for (const { comment: c } of rejectedComments) {
        this.stateMachine.unmarkCommentProcessed(job.repo, job.pr, c.id);
      }
      
      return { success: false, error: error.message };
    }
  }
}

const agent = new PRAutopilotAgent();

const command = process.argv[2];

if (command === 'status') {
  agent.printStatus();
} else if (command === 'process') {
  const repo = process.argv[3];
  const pr = Number(process.argv[4]);
  agent.enqueueManual(repo, pr).catch(error => {
    console.error('Manual enqueue failed', error);
    process.exit(1);
  });
} else {
  agent.start().catch(error => {
    console.error('Agent failed to start', error);
    process.exit(1);
  });
}
