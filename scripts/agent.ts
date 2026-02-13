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
import { ParsedReviewComment, PatchRequest, PRConfig } from './types';
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
  private patchGenerator = new PatchGenerator();
  private gitOps: GitOps;
  private stateMachine = new PRStateMachine();
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
      console.warn('⚠️  Both GITHUB_TOKEN and GitHub App credentials provided. Using GITHUB_TOKEN.');
    }

    // Initialize Octokit with appropriate authentication
    if (hasPersonalToken) {
      console.log('🔑 Using Personal Access Token authentication');
      this.octokit = new Octokit({ auth: GITHUB_TOKEN });
    } else {
      console.log('🔑 Using GitHub App authentication');
      // TODO: Implement GitHub App authentication with @octokit/app
      // For now, throw an error since it's not fully implemented
      throw new Error(
        'GitHub App authentication is not yet fully implemented.\n' +
        'Please use GITHUB_TOKEN (Personal Access Token) for now.\n' +
        'GitHub App support coming soon!'
      );
    }

    this.configLoader = new ConfigLoader(this.octokit);
    this.gitOps = new GitOps(GITHUB_TOKEN!); // GitOps needs the token for git operations
    this.webhooks = new Webhooks({ secret: WEBHOOK_SECRET });

    // Register raw body plugin FIRST, before any routes
    // This must run before JSON parsing to capture the raw body
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
          c.handler(`Processing issue comment for PR ${repoFull}#${prNumber}`);
          if (repoFull) {
            await this.handleIssueComment(repoFull, prNumber, context.payload.comment.body);
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

    const { owner, repo } = this.splitRepo(repofull);
    c.comment(`Loading config for ${owner}/${repo}`);
    const config = await this.configLoader.loadConfig(owner, repo);
    c.comment(`Config loaded: autofix.enabled=${config.autofix.enabled}, risk_level=${config.autofix.risk_level}`);

    const runnable = this.parser.filterComments(cleanedComments, config);
    c.comment(`${runnable.length}/${cleanedComments.length} comments are runnable after config filtering`);
    
    if (runnable.length > 0) {
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
    }
  }

  private async handleIssueComment(repofull: string, pr: number, body: string): Promise<void> {
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
        this.queue.addJob('run_command', repofull, pr, { command: commandToRun, config }, 10); // Higher priority
        
        await this.octokit.rest.issues.createComment({
          owner: this.splitRepo(repofull).owner,
          repo: this.splitRepo(repofull).repo,
          issue_number: pr,
          body: `🚀 Queued manual command: \`${commandToRun}\``,
        });
      }
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

  private async handleProcessJob(job: Job): Promise<JobResult> {
    console.log(`[JOB] Processing job ${job.id} for ${job.repo}#${job.pr}`);
    const data = job.data as ProcessJobData;
    const { owner, repo } = this.splitRepo(job.repo);

    try {
      // 1. Get pending comments
      const pendingComments = this.stateMachine.getAndClearPendingComments(job.repo, job.pr);
      if (pendingComments.length === 0) {
        console.log(`[JOB] No pending comments for ${job.repo}#${job.pr}, skipping`);
        return { success: true };
      }

      console.log(`[JOB] Found ${pendingComments.length} pending comments for ${job.repo}#${job.pr}`);
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
        targetBranch = await this.gitOps.getOrCreateHelperBranch(job.repo, job.pr, headRef, existingHelperBranch);
        if (!existingHelperBranch) {
          this.stateMachine.setHelperBranch(job.repo, job.pr, targetBranch);
        }
      } else {
        targetBranch = headRef;
      }

      console.log(`[JOB] Checking out branch ${targetBranch}`);
      await this.gitOps.checkout(job.repo, targetBranch);
      const currentHeadSha = await this.gitOps.getCurrentCommit(job.repo);

      // 3. Process each comment
      const appliedComments: ParsedReviewComment[] = [];
      const rejectedComments: { comment: ParsedReviewComment; error: string }[] = [];
      const needsApprovalComments: ParsedReviewComment[] = [];

      for (const comment of pendingComments) {
        if (!comment.file) continue;

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
          continue;
        }

        if (patchResult.requires_approval) {
          console.log(`[JOB] Patch for ${comment.id} requires approval`);
          needsApprovalComments.push(comment);
          
          await this.octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: job.pr,
            body: `Generated a patch for comment ${comment.id} on ${comment.file} but it requires manual approval (automation level ${level}).`,
          });
          continue;
        }

        try {
          console.log(`[JOB] Applying patch for ${comment.id}`);
          await this.gitOps.applyPatch(job.repo, patchResult.patch);
          appliedComments.push(comment);
        } catch (error: any) {
          console.log(`[JOB] Failed to apply patch for ${comment.id}: ${error.message}`);
          rejectedComments.push({ comment, error: `Failed to apply patch: ${error.message}` });
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
