import * as fs from 'fs';
import * as path from 'path';
import { ParsedReviewComment } from './types';

export interface TrackedComment extends Omit<ParsedReviewComment, 'commit_sha'> {
  commit_sha?: string;  // Make optional since it may not be set initially
  tracked_at: string;
  status: 'received' | 'queued' | 'processing' | 'patch_generated' | 'committed' | 'failed' | 'skipped';
  status_history: Array<{
    status: string;
    timestamp: string;
    details?: string;
  }>;
  patch?: string | null;  // Allow null
  commit_sha_final?: string;
  error?: string;
  retry_count?: number;
}

export interface PRCommentFile {
  repo: string;
  pr_number: number;
  created_at: string;
  updated_at: string;
  comments: TrackedComment[];
  stats: {
    total: number;
    received: number;
    queued: number;
    processing: number;
    patch_generated: number;
    committed: number;
    failed: number;
    skipped: number;
  };
}

export class CommentTracker {
  private baseDir: string;

  constructor(baseDir?: string) {
    // Use absolute path relative to project root if not specified
    this.baseDir = baseDir || path.resolve(process.cwd(), '.pr-autopilot');
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Get the file path for a PR's comments
   */
  private getFilePath(repo: string, prNumber: number): string {
    const safeRepo = repo.replace(/[\/\\]/g, '_');
    return path.join(this.baseDir, `${safeRepo}_pr_${prNumber}.json`);
  }

  /**
   * Load or create a PR comment file
   */
  loadPRFile(repo: string, prNumber: number): PRCommentFile {
    const filePath = this.getFilePath(repo, prNumber);
    
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
      } catch (error) {
        console.error(`[TRACKER] Error loading ${filePath}, creating new file:`, error);
      }
    }

    return {
      repo,
      pr_number: prNumber,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      comments: [],
      stats: {
        total: 0,
        received: 0,
        queued: 0,
        processing: 0,
        patch_generated: 0,
        committed: 0,
        failed: 0,
        skipped: 0,
      },
    };
  }

  /**
   * Save a PR comment file
   */
  savePRFile(file: PRCommentFile): void {
    const filePath = this.getFilePath(file.repo, file.pr_number);
    file.updated_at = new Date().toISOString();
    
    // Recalculate stats
    file.stats = {
      total: file.comments.length,
      received: file.comments.filter(c => c.status === 'received').length,
      queued: file.comments.filter(c => c.status === 'queued').length,
      processing: file.comments.filter(c => c.status === 'processing').length,
      patch_generated: file.comments.filter(c => c.status === 'patch_generated').length,
      committed: file.comments.filter(c => c.status === 'committed').length,
      failed: file.comments.filter(c => c.status === 'failed').length,
      skipped: file.comments.filter(c => c.status === 'skipped').length,
    };

    fs.writeFileSync(filePath, JSON.stringify(file, null, 2));
    console.log(`[TRACKER] Saved ${file.comments.length} comments to ${filePath}`);
  }

  /**
   * Add a new comment or update existing one
   */
  addComment(repo: string, prNumber: number, comment: ParsedReviewComment): TrackedComment {
    const file = this.loadPRFile(repo, prNumber);

    // Check if comment already exists
    const existingIndex = file.comments.findIndex(c => c.id === comment.id);

    const trackedComment: TrackedComment = {
      ...comment,
      tracked_at: new Date().toISOString(),
      status: 'received',
      status_history: [{
        status: 'received',
        timestamp: new Date().toISOString(),
      }],
    };

    if (existingIndex >= 0) {
      // FIX: Preserve existing metadata (retry/error/patch/commit fields) when updating
      const existing = file.comments[existingIndex];
      trackedComment.status_history = existing.status_history;
      trackedComment.status = existing.status;
      trackedComment.tracked_at = existing.tracked_at;
      trackedComment.patch = existing.patch;
      trackedComment.commit_sha = existing.commit_sha;
      trackedComment.commit_sha_final = existing.commit_sha_final;
      trackedComment.error = existing.error;
      trackedComment.retry_count = existing.retry_count;
      file.comments[existingIndex] = trackedComment;
    } else {
      file.comments.push(trackedComment);
    }

    this.savePRFile(file);
    return trackedComment;
  }

  /**
   * Add multiple comments at once
   */
  addComments(repo: string, prNumber: number, comments: ParsedReviewComment[]): TrackedComment[] {
    const file = this.loadPRFile(repo, prNumber);
    const trackedComments: TrackedComment[] = [];

    for (const comment of comments) {
      const existingIndex = file.comments.findIndex(c => c.id === comment.id);
      
      const trackedComment: TrackedComment = {
        ...comment,
        tracked_at: new Date().toISOString(),
        status: 'received',
        status_history: [{
          status: 'received',
          timestamp: new Date().toISOString(),
        }],
      };

      if (existingIndex >= 0) {
        const existing = file.comments[existingIndex];
        trackedComment.status_history = existing.status_history;
        trackedComment.status = existing.status;
        trackedComment.tracked_at = existing.tracked_at;
        file.comments[existingIndex] = trackedComment;
      } else {
        file.comments.push(trackedComment);
      }

      trackedComments.push(trackedComment);
    }

    this.savePRFile(file);
    return trackedComments;
  }

  /**
   * Update comment status
   */
  updateStatus(
    repo: string,
    prNumber: number,
    commentId: string,
    status: TrackedComment['status'],
    details?: { patch?: string; commit_sha?: string; error?: string }
  ): TrackedComment | null {
    const file = this.loadPRFile(repo, prNumber);
    const comment = file.comments.find(c => c.id === commentId);
    
    if (!comment) {
      console.warn(`[TRACKER] Comment ${commentId} not found`);
      return null;
    }

    comment.status = status;
    comment.status_history.push({
      status,
      timestamp: new Date().toISOString(),
      details: details ? JSON.stringify(details) : undefined,
    });

    if (details?.patch) comment.patch = details.patch;
    if (details?.commit_sha) comment.commit_sha = details.commit_sha;
    if (details?.error) comment.error = details.error;

    this.savePRFile(file);
    return comment;
  }

  /**
   * Get comments by status
   */
  getCommentsByStatus(repo: string, prNumber: number, status: TrackedComment['status']): TrackedComment[] {
    const file = this.loadPRFile(repo, prNumber);
    return file.comments.filter(c => c.status === status);
  }

  /**
   * Get pending comments (received or queued, not yet processed)
   */
  getPendingComments(repo: string, prNumber: number): TrackedComment[] {
    const file = this.loadPRFile(repo, prNumber);
    const pending = file.comments.filter(c =>
      c.status === 'received' ||
      c.status === 'queued' ||
      c.status === 'processing'
    );
    
    console.log(`[TRACKER] getPendingComments: ${repo}#${prNumber}`);
    console.log(`[TRACKER] Total comments: ${file.comments.length}`);
    console.log(`[TRACKER] Pending comments: ${pending.length}`);
    console.log(`[TRACKER] Status breakdown: received=${file.comments.filter(c => c.status === 'received').length}, queued=${file.comments.filter(c => c.status === 'queued').length}, processing=${file.comments.filter(c => c.status === 'processing').length}`);
    
    return pending;
  }

  /**
   * Get all comments for a PR
   */
  getAllComments(repo: string, prNumber: number): TrackedComment[] {
    const file = this.loadPRFile(repo, prNumber);
    return file.comments;
  }

  /**
   * Mark comments as queued
   */
  markQueued(repo: string, prNumber: number, commentIds: string[]): void {
    const file = this.loadPRFile(repo, prNumber);
    
    for (const id of commentIds) {
      const comment = file.comments.find(c => c.id === id);
      if (comment) {
        comment.status = 'queued';
        comment.status_history.push({
          status: 'queued',
          timestamp: new Date().toISOString(),
        });
      }
    }

    this.savePRFile(file);
  }

  /**
   * Increment retry count for a comment
   */
  incrementRetry(repo: string, prNumber: number, commentId: string): number {
    const file = this.loadPRFile(repo, prNumber);
    const comment = file.comments.find(c => c.id === commentId);
    
    if (!comment) return 0;
    
    comment.retry_count = (comment.retry_count || 0) + 1;
    this.savePRFile(file);
    
    return comment.retry_count;
  }

  /**
   * Generate a summary report
   */
  generateSummary(repo: string, prNumber: number): string {
    const file = this.loadPRFile(repo, prNumber);
    
    let summary = `# PR Comment Tracking Summary\n`;
    summary += `Repo: ${repo}\n`;
    summary += `PR: #${prNumber}\n`;
    summary += `Updated: ${file.updated_at}\n\n`;
    
    summary += `## Stats\n`;
    summary += `- Total: ${file.stats.total}\n`;
    summary += `- Received: ${file.stats.received}\n`;
    summary += `- Queued: ${file.stats.queued}\n`;
    summary += `- Processing: ${file.stats.processing}\n`;
    summary += `- Patch Generated: ${file.stats.patch_generated}\n`;
    summary += `- Committed: ${file.stats.committed}\n`;
    summary += `- Failed: ${file.stats.failed}\n`;
    summary += `- Skipped: ${file.stats.skipped}\n\n`;
    
    summary += `## Comments\n`;
    for (const comment of file.comments) {
      summary += `\n### Comment ${comment.id}\n`;
      summary += `- File: ${comment.file}:${comment.start_line}-${comment.end_line}\n`;
      summary += `- Author: ${comment.author}\n`;
      summary += `- Status: ${comment.status}\n`;
      summary += `- Retries: ${comment.retry_count || 0}\n`;
      if (comment.error) {
        summary += `- Error: ${comment.error}\n`;
      }
      if (comment.commit_sha) {
        summary += `- Commit: ${comment.commit_sha}\n`;
      }
    }

    return summary;
  }

  /**
   * List all tracked PRs
   */
  listTrackedPRs(): Array<{ repo: string; prNumber: number; file: string }> {
    const files = fs.readdirSync(this.baseDir).filter(f => f.endsWith('.json'));

    return files.map(f => {
      const match = f.match(/^(.+?)_pr_(\d+)\.json$/);
      if (match) {
        // FIX: Use smarter reconstruction - only replace FIRST underscore with /
        // Repos can have underscores, but owner/repo separator is the first underscore before _pr_
        const repoWithUnderscores = match[1];
        const firstUnderscoreIdx = repoWithUnderscores.indexOf('_');
        let repo: string;
        
        if (firstUnderscoreIdx > 0) {
          // Replace only the first underscore with /
          repo = repoWithUnderscores.substring(0, firstUnderscoreIdx) + '/' + 
                 repoWithUnderscores.substring(firstUnderscoreIdx + 1);
        } else {
          // No underscore found, use as-is (shouldn't happen normally)
          repo = repoWithUnderscores;
        }
        
        return {
          repo,
          prNumber: parseInt(match[2], 10),
          file: path.join(this.baseDir, f),
        };
      }
      return null;
    }).filter(Boolean) as Array<{ repo: string; prNumber: number; file: string }>;
  }

  /**
   * Clean up old files (older than specified days)
   */
  cleanupOldFiles(daysOld: number = 30): number {
    const files = fs.readdirSync(this.baseDir).filter(f => f.endsWith('.json'));
    const cutoff = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
    let cleaned = 0;

    for (const f of files) {
      const filePath = path.join(this.baseDir, f);
      try {
        const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const updatedAt = new Date(content.updated_at).getTime();
        
        if (updatedAt < cutoff) {
          fs.unlinkSync(filePath);
          cleaned++;
          console.log(`[TRACKER] Cleaned up old file: ${f}`);
        }
      } catch (error) {
        // If we can't parse it, consider removing it
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          cleaned++;
          console.log(`[TRACKER] Cleaned up unreadable file: ${f}`);
        }
      }
    }

    return cleaned;
  }
}
