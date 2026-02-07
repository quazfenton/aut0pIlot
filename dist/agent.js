import Fastify from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { Webhooks } from '@octokit/webhooks';
import { Octokit } from '@octokit/rest';
import { Queue } from './queue';
import { ReviewParser } from './review-parser';
import { ConfigLoader } from './config-loader';
import { PatchGenerator } from './patch-generator';
import { GitOps } from './git-ops';
import { PRStateMachine } from './state-machine';
const PORT = Number(process.env.AGENT_PORT ?? '3000');
// Authentication: Support both Personal Access Token and GitHub App
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_PRIVATE_KEY;
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
export class PRAutopilotAgent {
    fastify = Fastify({ logger: true });
    queue = new Queue();
    webhooks;
    octokit;
    parser = new ReviewParser();
    configLoader;
    patchGenerator = new PatchGenerator();
    gitOps;
    stateMachine = new PRStateMachine();
    constructor() {
        // Validate authentication configuration
        const hasPersonalToken = !!GITHUB_TOKEN;
        const hasGitHubApp = !!(GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY);
        if (!hasPersonalToken && !hasGitHubApp) {
            throw new Error('GitHub authentication required. Provide either:\n' +
                '  1. GITHUB_TOKEN (Personal Access Token), or\n' +
                '  2. GITHUB_APP_ID + GITHUB_PRIVATE_KEY (GitHub App)\n' +
                'See setup-github-app.ts for GitHub App setup instructions.');
        }
        if (hasPersonalToken && hasGitHubApp) {
            console.warn('⚠️  Both GITHUB_TOKEN and GitHub App credentials provided. Using GITHUB_TOKEN.');
        }
        // Initialize Octokit with appropriate authentication
        if (hasPersonalToken) {
            console.log('🔑 Using Personal Access Token authentication');
            this.octokit = new Octokit({ auth: GITHUB_TOKEN });
        }
        else {
            console.log('🔑 Using GitHub App authentication');
            // TODO: Implement GitHub App authentication with @octokit/app
            // For now, throw an error since it's not fully implemented
            throw new Error('GitHub App authentication is not yet fully implemented.\n' +
                'Please use GITHUB_TOKEN (Personal Access Token) for now.\n' +
                'GitHub App support coming soon!');
        }
        this.configLoader = new ConfigLoader(this.octokit);
        this.gitOps = new GitOps(GITHUB_TOKEN); // GitOps needs the token for git operations
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
    async start() {
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
            const deliveryId = request.headers['x-github-delivery'];
            const eventName = request.headers['x-github-event'];
            const signature = request.headers['x-hub-signature-256'];
            const webhookSource = request.headers['x-webhook-source'];
            // LOG: Webhook received
            console.log(`[WEBHOOK] Received: event=${eventName}, delivery=${deliveryId}, source=${webhookSource || 'direct'}`);
            // Check if rawBody is available
            const rawBody = request.rawBody || (request.body ? JSON.stringify(request.body) : '');
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
                    console.log(`[WEBHOOK] Processing queue webhook: event=${eventName}, action=${parsedPayload.action}`);
                    await this.webhooks.receive({
                        id: deliveryId,
                        name: eventName,
                        payload: parsedPayload
                    });
                    console.log(`[WEBHOOK] Queue webhook processed successfully`);
                    reply.send({ ok: true });
                }
                catch (error) {
                    console.error(`[WEBHOOK] Error processing queue webhook:`, error.message);
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
                console.log(`[WEBHOOK] Processing verified webhook: event=${eventName}, action=${parsedPayload.action}`);
                await this.webhooks.receive({
                    id: deliveryId,
                    name: eventName,
                    payload: parsedPayload
                });
                console.log(`[WEBHOOK] Verified webhook processed successfully`);
                reply.send({ ok: true });
            }
            catch (error) {
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
    async printStatus() {
        const status = this.queue.getStatus();
        console.log('Queue status', status);
    }
    async enqueueManual(repoFull, pr) {
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
            .filter(Boolean);
        const reviewParsed = reviews.flatMap(review => this.parser.parseReview({ review, pull_request: prData.data }));
        const aggregated = [...inline, ...reviewParsed];
        await this.handleCommentEvent(repoFull, pr, aggregated);
        console.log(`Re-enqueued ${aggregated.length} comments for ${repoFull}#${pr}.`);
    }
    registerWebhookHandlers() {
        this.webhooks.on('pull_request_review_comment', async (context) => {
            console.log(`[HANDLER] pull_request_review_comment triggered: action=${context.payload.action}`);
            try {
                if (context.payload.action !== 'created') {
                    console.log(`[HANDLER] Skipping: action is '${context.payload.action}', expected 'created'`);
                    return;
                }
                const repoFull = context.payload.repository?.full_name;
                const prNumber = context.payload.pull_request?.number;
                console.log(`[HANDLER] Parsing inline comment for ${repoFull}#${prNumber}`);
                const comment = this.parser.parseInlineComment(context.payload);
                console.log(`[HANDLER] Parsed comment:`, comment ? { id: comment.id, type: comment.type, file: comment.file } : null);
                if (repoFull && prNumber && comment) {
                    await this.handleCommentEvent(repoFull, prNumber, [comment]);
                }
                else {
                    console.log(`[HANDLER] Skipping: missing repoFull=${!!repoFull}, prNumber=${!!prNumber}, comment=${!!comment}`);
                }
            }
            catch (error) {
                console.error(`[HANDLER] Error in pull_request_review_comment handler:`, error.message);
            }
        });
        this.webhooks.on('pull_request_review', async (context) => {
            console.log(`[HANDLER] pull_request_review triggered: action=${context.payload.action}`);
            try {
                if (context.payload.action !== 'submitted') {
                    console.log(`[HANDLER] Skipping: action is '${context.payload.action}', expected 'submitted'`);
                    return;
                }
                const repoFull = context.payload.repository?.full_name;
                const prNumber = context.payload.pull_request?.number;
                console.log(`[HANDLER] Parsing review for ${repoFull}#${prNumber}`);
                const comments = this.parser.parseReview(context.payload);
                console.log(`[HANDLER] Parsed ${comments.length} comments from review`);
                if (repoFull && prNumber) {
                    await this.handleCommentEvent(repoFull, prNumber, comments);
                }
                else {
                    console.log(`[HANDLER] Skipping: missing repoFull=${!!repoFull}, prNumber=${!!prNumber}`);
                }
            }
            catch (error) {
                console.error(`[HANDLER] Error in pull_request_review handler:`, error.message);
            }
        });
        this.webhooks.on('issue_comment', async (context) => {
            console.log(`[HANDLER] issue_comment triggered: action=${context.payload.action}`);
            try {
                if (context.payload.issue.pull_request) {
                    const repoFull = context.payload.repository?.full_name;
                    const prNumber = context.payload.issue.number;
                    console.log(`[HANDLER] Processing issue comment for PR ${repoFull}#${prNumber}`);
                    if (repoFull) {
                        await this.handleIssueComment(repoFull, prNumber, context.payload.comment.body);
                    }
                }
                else {
                    console.log(`[HANDLER] Skipping: not a PR comment`);
                }
            }
            catch (error) {
                console.error(`[HANDLER] Error in issue_comment handler:`, error.message);
            }
        });
        this.webhooks.on('pull_request', async (context) => {
            console.log(`[HANDLER] pull_request triggered: action=${context.payload.action}`);
            try {
                const repoFull = context.payload.repository?.full_name;
                if (repoFull && ['opened', 'reopened', 'synchronize'].includes(context.payload.action)) {
                    console.log(`[HANDLER] Resetting state for ${repoFull}#${context.payload.number}`);
                    this.stateMachine.resetState(repoFull, context.payload.number);
                }
                else {
                    console.log(`[HANDLER] Skipping: action '${context.payload.action}' not in handled list`);
                }
            }
            catch (error) {
                console.error(`[HANDLER] Error in pull_request handler:`, error.message);
            }
        });
        console.log('[AGENT] Webhook handlers registered');
    }
    async handleCommentEvent(repofull, pr, comments) {
        console.log(`[COMMENT_EVENT] Handling ${comments.length} comments for ${repofull}#${pr}`);
        const cleanedComments = comments.filter(Boolean);
        console.log(`[COMMENT_EVENT] ${cleanedComments.length} comments after filtering nulls`);
        if (!cleanedComments.length) {
            console.log(`[COMMENT_EVENT] No valid comments to process, returning`);
            return;
        }
        const { owner, repo } = this.splitRepo(repofull);
        console.log(`[COMMENT_EVENT] Loading config for ${owner}/${repo}`);
        const config = await this.configLoader.loadConfig(owner, repo);
        console.log(`[COMMENT_EVENT] Config loaded: autofix.enabled=${config.autofix.enabled}, risk_level=${config.autofix.risk_level}`);
        const runnable = this.parser.filterComments(cleanedComments, config);
        console.log(`[COMMENT_EVENT] ${runnable.length}/${cleanedComments.length} comments are runnable after config filtering`);
        let queuedCount = 0;
        for (const comment of runnable) {
            if (this.stateMachine.isCommentProcessed(repofull, pr, comment.id)) {
                console.log(`[COMMENT_EVENT] Comment ${comment.id} already processed, skipping`);
                continue;
            }
            console.log(`[COMMENT_EVENT] Queueing job for comment ${comment.id} (${comment.type} on ${comment.file})`);
            this.queue.addJob('process_pr', repofull, pr, { comment, config }, 0);
            queuedCount++;
        }
        console.log(`[COMMENT_EVENT] Queued ${queuedCount} jobs for ${repofull}#${pr}`);
    }
    async handleIssueComment(repofull, pr, body) {
        console.log(`[ISSUE_COMMENT] Handling command in ${repofull}#${pr}: ${body.slice(0, 50)}...`);
        if (body.trim().startsWith('/stop-autofix')) {
            console.log(`[ISSUE_COMMENT] Stop command detected, blocking PR`);
            this.stateMachine.transition(repofull, pr, 'BLOCKED', 'Manual stop command received');
            await this.octokit.rest.issues.createComment({
                owner: this.splitRepo(repofull).owner,
                repo: this.splitRepo(repofull).repo,
                issue_number: pr,
                body: 'Auto-fixes halted for this PR. Remove `/stop-autofix` to resume.',
            });
        }
    }
    splitRepo(repofull) {
        const [owner = '', repo = ''] = repofull.split('/');
        return { owner, repo };
    }
    determineAutomationLevel(comment, config) {
        if (comment.type === 'suggested_change') {
            return 1;
        }
        if (config.autofix.risk_level === 'low' || this.parser.requiresApproval(comment, config.autofix.risk_level)) {
            return 3;
        }
        return 2;
    }
    async handleProcessJob(job) {
        console.log(`[JOB] Processing job ${job.id} for ${job.repo}#${job.pr}`);
        const data = job.data;
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
            const headSha = comment.commit_sha || pr.data.head.sha;
            const headRef = pr.data.head.ref;
            console.log(`[JOB] PR head: ${headSha} on branch ${headRef}`);
            const patchRequest = {
                repo: job.repo,
                pr: job.pr,
                commit_sha: headSha,
                file: comment.file,
                start_line: comment.start_line,
                end_line: comment.end_line,
                content: comment.content,
                context: comment.diff_hunk,
                diff_hunk: comment.diff_hunk,
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
                    body: `Generated a patch for comment ${comment.id} but marked for manual approval (level ${level}).`,
                });
                this.stateMachine.markCommentProcessed(job.repo, job.pr, comment.id);
                return { success: true };
            }
            console.log(`[JOB] Cloning repo ${job.repo}`);
            await this.gitOps.clone(job.repo);
            console.log(`[JOB] Checking out branch ${headRef}`);
            await this.gitOps.checkout(job.repo, headRef);
            console.log(`[JOB] Applying patch`);
            await this.gitOps.applyPatch(job.repo, patchResult.patch);
            console.log(`[JOB] Committing changes`);
            const commitSha = await this.gitOps.commit(job.repo, `chore(pr-${job.pr}): apply review comment ${comment.id}`);
            console.log(`[JOB] Committed as ${commitSha}`);
            console.log(`[JOB] Pushing to ${headRef}`);
            await this.gitOps.push(job.repo, headRef);
            console.log(`[JOB] Creating success comment on PR`);
            await this.octokit.rest.issues.createComment({
                owner,
                repo,
                issue_number: job.pr,
                body: `Applied comment ${comment.id} (automation level ${level}). Re-running checks.`,
            });
            this.stateMachine.incrementIteration(job.repo, job.pr);
            this.stateMachine.markCommentProcessed(job.repo, job.pr, comment.id);
            this.stateMachine.transition(job.repo, job.pr, 'PUSHED');
            console.log(`[JOB] Job ${job.id} completed successfully`);
            return { success: true };
        }
        catch (error) {
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
}
else if (command === 'process') {
    const repo = process.argv[3];
    const pr = Number(process.argv[4]);
    agent.enqueueManual(repo, pr).catch(error => {
        console.error('Manual enqueue failed', error);
        process.exit(1);
    });
}
else {
    agent.start().catch(error => {
        console.error('Agent failed to start', error);
        process.exit(1);
    });
}
