#!/usr/bin/env bun
/**
 * Re-apply fixes from a comments file
 * Creates a new branch from the latest PR head and applies fixes
 * 
 * Usage: bun run scripts/reapply-fixes.ts <comments-file.json> [options]
 * 
 * Options:
 *   --dry-run              Show what would be done without applying
 *   --status=<status>     Only reprocess comments with this status
 *   --comment-id=<id>      Only reprocess a specific comment
 *   --force                Re-apply even if already committed
 *   --use-qwen             Use Qwen for patch generation
 *   --skip-committed       Skip comments that are already committed
 *   --merge-to-pr          Merge the reapply branch back to the PR when done
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { PatchGenerator } from './patch-generator';
import { GitOps } from './git-ops';
import { CommentTracker, TrackedComment, PRCommentFile } from './comment-tracker';
import { PatchRequest } from './types';
import { Octokit } from '@octokit/rest';

const log = {
  header:  (msg: string) => console.log(`\n\x1b[1;38;5;208m[REAPPLY] ══ ${msg} ══\x1b[0m`),
  step:    (msg: string) => console.log(`\x1b[32m[STEP]\x1b[0m ${msg}`),
  detail:  (msg: string) => console.log(`\x1b[2m[DETAIL] ${msg}`),
  warn:    (msg: string) => console.log(`\x1b[1;33m[WARN]\x1b[0m ${msg}`),
  error:   (msg: string) => console.log(`\x1b[1;31m[ERROR]\x1b[0m ${msg}`),
  success: (msg: string) => console.log(`\x1b[1;32m[SUCCESS]\x1b[0m ${msg}`),
  skip:    (msg: string) => console.log(`\x1b[38;5;240m[SKIP]\x1b[0m ${msg}`),
};

interface ReapplyOptions {
  dryRun: boolean;
  status?: string;
  commentId?: string;
  force: boolean;
  useQwen: boolean;
  skipCommitted: boolean;
  mergeToPr: boolean;
}

function parseArgs(): { file: string; options: ReapplyOptions } {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0].startsWith('--')) {
    console.error('Usage: bun run scripts/reapply-fixes.ts <comments-file.json> [options]');
    console.error('\nOptions:');
    console.error('  --dry-run         Show what would be done without applying');
    console.error('  --status=<status> Only reprocess comments with this status');
    console.error('  --comment-id=<id> Only reprocess a specific comment');
    console.error('  --force           Re-apply even if already committed');
    console.error('  --skip-committed  Skip comments that are already committed (default: true)');
    console.error('  --use-qwen        Use Qwen for patch generation');
    console.error('  --merge-to-pr     Merge reapply branch back to PR when done');
    process.exit(1);
  }

  const file = args[0];
  const options: ReapplyOptions = {
    dryRun: args.includes('--dry-run'),
    status: args.find(a => a.startsWith('--status='))?.split('=')[1],
    commentId: args.find(a => a.startsWith('--comment-id='))?.split('=')[1],
    force: args.includes('--force'),
    useQwen: args.includes('--use-qwen'),
    skipCommitted: args.includes('--skip-committed') || !args.includes('--process-committed'),
    mergeToPr: args.includes('--merge-to-pr'),
  };

  return { file, options };
}

function validatePatchQuality(patch: string, comment: TrackedComment): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  
  if (!patch.startsWith('--- a/')) {
    issues.push('Missing --- a/ header');
  }
  if (!patch.includes('+++ b/')) {
    issues.push('Missing +++ b/ header');
  }
  
  const hunkMatch = patch.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
  if (!hunkMatch) {
    issues.push('Missing or invalid @@ hunk marker');
  } else {
    const oldStart = parseInt(hunkMatch[1], 10);
    const expectedLine = comment.start_line;
    if (Math.abs(oldStart - expectedLine) > 10) {
      issues.push(`Hunk starts at line ${oldStart}, expected near ${expectedLine}`);
    }
  }
  
  return { valid: issues.length === 0, issues };
}

async function reapplyFix(
  comment: TrackedComment,
  repo: string,
  prNumber: number,
  gitOps: GitOps,
  patchGenerator: PatchGenerator,
  options: ReapplyOptions,
  commentTracker: CommentTracker,
  reapplyBranch: string
): Promise<{ success: boolean; error?: string }> {
  const repoDir = gitOps.getRepoDir(repo);
  
  log.step(`Processing comment ${comment.id} (${comment.file}:${comment.start_line})`);
  
  // Check if already committed and skipping
  if (comment.status === 'committed' && options.skipCommitted && !options.force) {
    log.skip(`Comment ${comment.id} already committed, skipping (use --force to re-apply)`);
    return { success: true };
  }
  
  // Update status
  if (!options.dryRun) {
    commentTracker.updateStatus(repo, prNumber, comment.id, 'processing');
  }

  const request = {
    repo,
    pr: prNumber,
    commit_sha: comment.commit_sha || 'HEAD',
    file: comment.file,
    start_line: comment.start_line,
    end_line: comment.end_line,
    content: comment.content,
    diff_hunk: comment.diff_hunk,
    suggestions: comment.suggestions,
    proposed_fixes: comment.proposed_fixes,
    agent_prompt: comment.agent_prompt,
  };

  if (options.useQwen) {
    process.env.USE_QWEN_PRIMARY = 'true';
    process.env.QWEN_DISCOVERY_MODE = 'true';
  }

  const result = await patchGenerator.generatePatch(request, 2, false);
  
  if (!result.success || !result.patch) {
    log.error(`Patch generation failed: ${result.error}`);
    if (!options.dryRun) {
      commentTracker.updateStatus(repo, prNumber, comment.id, 'failed', { error: result.error });
    }
    return { success: false, error: result.error };
  }
  
  const quality = validatePatchQuality(result.patch, comment);
  if (!quality.valid) {
    log.warn(`Patch quality issues: ${quality.issues.join(', ')}`);
  }
  
  log.detail(`Generated patch (${result.patch.length} chars)`);
  
  if (options.dryRun) {
    log.success(`[DRY-RUN] Would apply patch for comment ${comment.id}`);
    console.log('\n--- PATCH PREVIEW ---');
    console.log(result.patch);
    console.log('--- END PATCH ---\n');
    return { success: true };
  }
  
  try {
    await gitOps.applyPatch(repo, result.patch);
  } catch (error: any) {
    log.error(`Failed to apply patch: ${error.message}`);
    commentTracker.updateStatus(repo, prNumber, comment.id, 'failed', { error: error.message });
    return { success: false, error: error.message };
  }
  
  const commitMsg = `fix: re-apply fix for ${comment.file}:${comment.start_line}

Comment ID: ${comment.id}
Author: ${comment.author}
URL: ${comment.url}`;

  try {
    const commitSha = await gitOps.commit(repo, commitMsg);
    log.success(`Committed as ${commitSha}`);
    
    commentTracker.updateStatus(repo, prNumber, comment.id, 'committed', { 
      commit_sha: commitSha,
      patch: result.patch 
    });
    
    return { success: true };
  } catch (error: any) {
    log.error(`Failed to commit: ${error.message}`);
    commentTracker.updateStatus(repo, prNumber, comment.id, 'failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

async function main() {
  const { file, options } = parseArgs();
  
  const filePath = path.isAbsolute(file) ? file : path.resolve(file);
  
  if (!fs.existsSync(filePath)) {
    log.error(`File not found: ${filePath}`);
    process.exit(1);
  }
  
  log.header(`Re-applying fixes from ${filePath}`);
  log.detail(`Options: skipCommitted=${options.skipCommitted}, mergeToPr=${options.mergeToPr}`);
  
  let data: PRCommentFile;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    data = JSON.parse(content);
  } catch (error: any) {
    log.error(`Failed to read/parse file: ${error.message}`);
    process.exit(1);
  }
  
  const { repo, pr_number, comments } = data;
  log.step(`Repository: ${repo}, PR: ${pr_number}`);
  log.step(`Total comments: ${comments.length}`);
  
  // Filter comments
  let filteredComments = comments;
  
  if (options.status) {
    filteredComments = filteredComments.filter(c => c.status === options.status);
    log.detail(`Filtered by status '${options.status}': ${filteredComments.length} comments`);
  }
  
  if (options.commentId) {
    filteredComments = filteredComments.filter(c => c.id === options.commentId);
    log.detail(`Filtered by ID '${options.commentId}': ${filteredComments.length} comments`);
  }

  if (options.skipCommitted) {
    const before = filteredComments.length;
    filteredComments = filteredComments.filter(c => c.status !== 'committed' || options.force);
    log.detail(`Skipped committed: ${before - filteredComments.length} comments`);
  }
  
  if (filteredComments.length === 0) {
    log.warn('No comments to process after filtering');
    process.exit(0);
  }
  
  // Initialize
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    log.error('GITHUB_TOKEN environment variable is required');
    process.exit(1);
  }
  
  const github = new Octokit({ auth: token });
  const gitOps = new GitOps(token);
  const patchGenerator = new PatchGenerator();
  const commentTracker = new CommentTracker(path.dirname(filePath));
  
  try {
    // Get current PR head from GitHub
    const [owner, repoName] = repo.split('/');
    log.step(`Fetching current PR head for ${owner}/${repoName}#${pr_number}...`);
    
    const prData = await github.rest.pulls.get({
      owner,
      repo: repoName,
      pull_number: pr_number
    });
    const currentHeadSha = prData.data.head.sha;
    const currentBranch = prData.data.head.ref;
    
    log.success(`Current PR head: ${currentHeadSha.substring(0, 7)} (${currentBranch})`);
    
    // Clone the repo
    log.step(`Cloning ${repo}...`);
    await gitOps.clone(repo);
    
    // Create a new reapply branch from current PR head
    const reapplyBranch = `reapply-pr-${pr_number}-${Date.now()}`;
    
    // First checkout the current PR head
    await gitOps.checkout(repo, currentHeadSha);
    
    // Create and checkout the new reapply branch
    const repoDir = gitOps.getRepoDir(repo);
    execSync(`git checkout -b ${reapplyBranch}`, { cwd: repoDir, stdio: 'pipe' });
    
    log.success(`Created branch '${reapplyBranch}' from current PR head`);
    
    // Process each comment
    const results: { id: string; success: boolean; error?: string }[] = [];
    
    for (const comment of filteredComments) {
      const result = await reapplyFix(
        comment,
        repo,
        pr_number,
        gitOps,
        patchGenerator,
        options,
        commentTracker,
        reapplyBranch
      );
      results.push({ id: comment.id, ...result });
    }
    
    const successes = results.filter(r => r.success).length;
    
    if (successes > 0 && !options.dryRun) {
      log.step(`Pushing ${successes} commits...`);
      try {
        await gitOps.push(repo, reapplyBranch);
        log.success(`Pushed ${reapplyBranch} to remote`);
        
        // Optionally merge to PR
        if (options.mergeToPr) {
          log.step(`Creating PR from ${reapplyBranch}...`);
          try {
            await github.rest.pulls.create({
              owner,
              repo: repoName,
              title: `[Auto] Re-apply fixes from PR #${pr_number}`,
              head: reapplyBranch,
              base: currentBranch,
              body: `Re-applied fixes from comment file: ${path.basename(filePath)}`
            });
            log.success(`Created PR from ${reapplyBranch}`);
          } catch (prError: any) {
            if (prError.status === 422) {
              log.warn(`Branch already exists as PR, trying to update...`);
              // Branch already exists as PR - that's fine
            } else {
              log.error(`Failed to create PR: ${prError.message}`);
            }
          }
        }
      } catch (pushError: any) {
        log.error(`Failed to push: ${pushError.message}`);
      }
    }
    
    log.header('Summary');
    console.log(`Total:   ${results.length}`);
    console.log(`Success: ${successes}`);
    console.log(`Failed:  ${results.length - successes}`);
    console.log(`\nReapply branch: ${reapplyBranch}`);
    console.log(`Base:    ${currentBranch} (${currentHeadSha.substring(0, 7)})`);
    
    if (results.some(r => !r.success)) {
      console.log('\nFailed comments:');
      results.filter(r => !r.success).forEach(r => {
        console.log(`  - ${r.id}: ${r.error}`);
      });
    }
    
    if (!options.mergeToPr && successes > 0) {
      console.log(`\nTo merge: Create a PR from '${reapplyBranch}' to '${currentBranch}'`);
    }
    
  } finally {
    gitOps.cleanup();
    patchGenerator.cleanup();
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});