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

const c = {
  job:     (msg: string) => console.log(`\x1b[34m[JOB]\x1b[0m ${msg}`),
  handler: (msg: string) => console.log(`\x1b[35m[HANDLER]\x1b[0m ${msg}`),
  webhook: (msg: string) => console.log(`\x1b[36m[WEBHOOK]\x1b[0m ${msg}`),
  comment: (msg: string) => console.log(`\x1b[33m[COMMENT]\x1b[0m ${msg}`),
  filter:  (msg: string) => console.log(`\x1b[2m[FILTER]\x1b[0m ${msg}`),
  error:   (msg: string) => console.log(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
  success: (msg: string) => console.log(`\x1b[1;32m[OK]\x1b[0m ${msg}`),
};

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
  private webhooks: Webhooks;
  private octokit: Octokit;
  private parser = new ReviewParser();
  private configLoader: ConfigLoader;
  private patchGenerator = new PatchGenerator();
  private gitOps: GitOps;
  private stateMachine = new PRStateMachine();

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
    this.registerWebhookHandlers();
    this.queue.start(1500);
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
    
    let queuedCount = 0;
    for (const comment of runnable) {
      if (this.stateMachine.isCommentProcessed(repofull, pr, comment.id)) {
        c.comment(`Comment ${comment.id} already processed, skipping`);
        continue;
      }
      c.comment(`Queueing job for comment ${comment.id} (${comment.type} on ${comment.file})`);
      this.queue.addJob('process_pr', repofull, pr, { comment, config }, 0);
      queuedCount++;
    }
    c.comment(`Queued ${queuedCount} jobs for ${repofull}#${pr}`);
  }

  private async handleIssueComment(repofull: string, pr: number, body: string): Promise<void> {
    c.comment(`Handling command in ${repofull}#${pr}: ${body.slice(0, 50)}...`);
    if (body.trim().startsWith('/stop-autofix')) {
      c.comment(`Stop command detected, blocking PR`);
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
    console.log(`[JOB] Processing job ${job.id} for ${job.repo}#${job.pr}`);
    const data = job.data as ProcessJobData;
    if (!data?.comment) {
      console.log(`[JOB] Missing comment payload, failing job`);
      return { success: false, error: 'Missing comment payload' };
    }

    const comment = data.comment;
    const { owner, repo } = this.splitRepo(job.repo);

    try {
      console.log(`[JOB] Transitioning state to FIXING for ${job.repo}#${job.pr}`);
      this.stateMachine.transition(job.repo, job.pr, 'FIXING');

      if (!comment.file) {
        console.log(`[JOB] No file specified in comment, skipping`);
        return { success: true };
      }

      console.log(`[JOB] Fetching PR data for ${owner}/${repo}#${job.pr}`);
      const pr = await this.octokit.rest.pulls.get({ owner, repo, pull_number: job.pr });
      const headRef = pr.data.head.ref;
      console.log(`[JOB] PR head ref: ${headRef}`);

      console.log(`[JOB] Cloning repo ${job.repo}`);
      await this.gitOps.clone(job.repo);

      // Determine branch strategy based on config
      let targetBranch: string;
      if (data.config.autofix.branch_strategy === 'helper_pr') {
        // Create a new branch for fixes, based on the PR's head branch
        const iteration = this.stateMachine.getState(job.repo, job.pr).iteration;
        targetBranch = await this.gitOps.createAutofixBranch(job.repo, job.pr, iteration);
        console.log(`[JOB] Created/checked out helper branch: ${targetBranch}`);
      } else {
        // Use the same PR branch (original behavior)
        targetBranch = headRef;
        console.log(`[JOB] Using same PR branch: ${targetBranch}`);
      }

      console.log(`[JOB] Checking out branch ${targetBranch}`);
      await this.gitOps.checkout(job.repo, targetBranch);

      const currentHeadSha = await this.gitOps.getCurrentCommit(job.repo);
      console.log(`[JOB] Current HEAD after checkout: ${currentHeadSha}`);

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

      const level = this.determineAutomationLevel(comment, data.config);
      console.log(`[JOB] Determined automation level ${level} for comment ${comment.id}`);
      
      console.log(`[JOB] Generating patch for ${comment.file}`);
      const patchResult = await this.patchGenerator.generatePatch(patchRequest, level);

      if (!patchResult.success || !patchResult.patch) {
        console.log(`[JOB] Patch generation failed: ${patchResult.error}`);
        return { success: false, error: patchResult.error || 'Patch generation failed' };
      }

      if (patchResult.requires_approval) {
        console.log(`[JOB] Patch requires approval (level ${level}), commenting and marking processed`);
        await this.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: job.pr,
          body: `Generated a patch for comment ${comment.id} on ${comment.file} but marked for manual approval (level ${level}).`,
        });
        this.stateMachine.markCommentProcessed(job.repo, job.pr, comment.id);
        return { success: true };
      }
      
      console.log(`[JOB] Applying patch`);
      await this.gitOps.applyPatch(job.repo, patchResult.patch);
      
      console.log(`[JOB] Committing changes`);
      const commitSha = await this.gitOps.commit(job.repo, `chore(pr-${job.pr}): fixed ${comment.file}`);
      console.log(`[JOB] Committed as ${commitSha}`);
      
      console.log(`[JOB] Pushing to ${targetBranch}`);
      await this.gitOps.push(job.repo, targetBranch);

      console.log(`[JOB] Creating success comment on PR`);
      await this.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: job.pr,
        body: `Applied comment ${comment.id} on ${comment.file} (automation level ${level}). Re-running checks.`,
      });

      this.stateMachine.incrementIteration(job.repo, job.pr);
      this.stateMachine.markCommentProcessed(job.repo, job.pr, comment.id);
      this.stateMachine.transition(job.repo, job.pr, 'PUSHED');

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
