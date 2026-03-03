import * as fs from 'fs';
import * as path from 'path';
import { Octokit } from '@octokit/rest';

export interface PendingApproval {
  id: string;
  repo: string;
  pr: number;
  commentId: string;
  file: string;
  startLine: number;
  endLine: number;
  patch: string;
  reason: 'risky_file' | 'risky_pattern' | 'risk_keyword' | 'manual_flag';
  createdAt: string;
  status: 'pending' | 'approved' | 'rejected';
  approvedBy?: string;
  approvedAt?: string;
  reviewComment?: string;
}

export interface ApprovalConfig {
  require_approval_for: {
    files: string[];
    patterns: string[];
    risk_keywords: string[];
  };
  approval_methods: string[];
  approvers: string[];
  auto_approve_bots: string[];
}

export class ApprovalManager {
  private baseDir: string;
  private approvalsFile: string;
  private octokit: Octokit;

  constructor(octokit: Octokit, baseDir?: string) {
    this.octokit = octokit;
    this.baseDir = baseDir || path.resolve(process.cwd(), '.pr-autopilot');
    this.approvalsFile = path.join(this.baseDir, 'pending-approvals.json');
    
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Check if a patch requires approval
   */
  requiresApproval(
    file: string,
    patch: string,
    commentContent: string,
    riskLevel: string
  ): { requires: boolean; reason?: PendingApproval['reason'] } {
    // Load config
    const config = this.loadConfig();
    
    // High risk level always requires approval
    if (riskLevel === 'high') {
      return { requires: true, reason: 'risk_keyword' };
    }

    // Check file patterns
    for (const pattern of config.require_approval_for.files) {
      if (this.matchesPattern(file, pattern)) {
        console.log(`[APPROVAL] File ${file} matches pattern ${pattern}`);
        return { requires: true, reason: 'risky_file' };
      }
    }

    // Check content patterns
    const patchLower = (patch + commentContent).toLowerCase();
    for (const pattern of config.require_approval_for.patterns) {
      if (new RegExp(pattern, 'i').test(patchLower)) {
        console.log(`[APPROVAL] Content matches pattern ${pattern}`);
        return { requires: true, reason: 'risky_pattern' };
      }
    }

    // Check risk keywords
    for (const keyword of config.require_approval_for.risk_keywords) {
      if (patchLower.includes(keyword.toLowerCase())) {
        console.log(`[APPROVAL] Content contains risk keyword: ${keyword}`);
        return { requires: true, reason: 'risk_keyword' };
      }
    }

    return { requires: false };
  }

  /**
   * Add a patch to pending approvals
   */
  addPendingApproval(
    repo: string,
    pr: number,
    commentId: string,
    file: string,
    startLine: number,
    endLine: number,
    patch: string,
    reason: PendingApproval['reason']
  ): PendingApproval {
    const approvals = this.loadApprovals();
    
    const approval: PendingApproval = {
      id: `approval-${repo.replace(/\//g, '_')}-${pr}-${commentId}`,
      repo,
      pr,
      commentId,
      file,
      startLine,
      endLine,
      patch,
      reason,
      createdAt: new Date().toISOString(),
      status: 'pending'
    };

    // Check if already exists
    const existingIndex = approvals.findIndex(a => a.id === approval.id);
    if (existingIndex >= 0) {
      approvals[existingIndex] = approval;
    } else {
      approvals.push(approval);
    }

    this.saveApprovals(approvals);
    console.log(`[APPROVAL] Added pending approval: ${approval.id}`);
    
    return approval;
  }

  /**
   * Approve a pending patch
   */
  async approve(
    repo: string,
    pr: number,
    approvalId: string,
    approvedBy: string
  ): Promise<boolean> {
    const approvals = this.loadApprovals();
    const approval = approvals.find(a => a.id === approvalId);

    if (!approval) {
      console.error(`[APPROVAL] Approval ${approvalId} not found`);
      return false;
    }

    if (approval.status !== 'pending') {
      console.warn(`[APPROVAL] Approval ${approvalId} already ${approval.status}`);
      return false;
    }

    // Update approval
    approval.status = 'approved';
    approval.approvedBy = approvedBy;
    approval.approvedAt = new Date().toISOString();

    this.saveApprovals(approvals);
    console.log(`[APPROVAL] Approved ${approvalId} by ${approvedBy}`);

    // Post comment to PR
    await this.postApprovalComment(repo, pr, approval, 'approved', approvedBy);

    return true;
  }

  /**
   * Reject a pending patch
   */
  async reject(
    repo: string,
    pr: number,
    approvalId: string,
    rejectedBy: string,
    reason?: string
  ): Promise<boolean> {
    const approvals = this.loadApprovals();
    const approval = approvals.find(a => a.id === approvalId);

    if (!approval) {
      console.error(`[APPROVAL] Approval ${approvalId} not found`);
      return false;
    }

    if (approval.status !== 'pending') {
      console.warn(`[APPROVAL] Approval ${approvalId} already ${approval.status}`);
      return false;
    }

    // Update approval
    approval.status = 'rejected';
    approval.approvedBy = rejectedBy;
    approval.approvedAt = new Date().toISOString();
    approval.reviewComment = reason;

    this.saveApprovals(approvals);
    console.log(`[APPROVAL] Rejected ${approvalId} by ${rejectedBy}`);

    // Post comment to PR
    await this.postApprovalComment(repo, pr, approval, 'rejected', rejectedBy, reason);

    return true;
  }

  /**
   * Get pending approvals for a PR
   */
  getPendingApprovals(repo: string, pr?: number): PendingApproval[] {
    const approvals = this.loadApprovals();
    
    return approvals.filter(a => {
      if (a.status !== 'pending') return false;
      if (a.repo !== repo) return false;
      if (pr !== undefined && a.pr !== pr) return false;
      return true;
    });
  }

  /**
   * Get approval by ID
   */
  getApproval(approvalId: string): PendingApproval | undefined {
    const approvals = this.loadApprovals();
    return approvals.find(a => a.id === approvalId);
  }

  /**
   * List all approvals (for admin view)
   */
  listApprovals(status?: PendingApproval['status']): PendingApproval[] {
    const approvals = this.loadApprovals();
    
    if (status) {
      return approvals.filter(a => a.status === status);
    }
    
    return approvals;
  }

  /**
   * Clean up old approvals
   */
  cleanupOldApprovals(daysOld: number = 7): number {
    const approvals = this.loadApprovals();
    const cutoff = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
    
    const remaining = approvals.filter(a => {
      const createdAt = new Date(a.createdAt).getTime();
      return a.status === 'pending' || createdAt > cutoff;
    });
    
    const removed = approvals.length - remaining.length;
    this.saveApprovals(remaining);
    
    return removed;
  }

  /**
   * Check if user is allowed to approve
   */
  async canUserApprove(
    repo: string,
    username: string,
    pr: number
  ): Promise<boolean> {
    const config = this.loadConfig();
    
    // Check if user is in approvers list
    if (config.approvers.includes(username) || config.approvers.includes(`@${username}`)) {
      return true;
    }

    // Check if user is repo owner/admin
    try {
      const [owner, repoName] = repo.split('/');
      const membership = await this.octokit.repos.checkCollaborator({
        owner,
        repo: repoName,
        username
      });
      
      if (membership.status === 204) {
        // User is a collaborator, check permission level
        const permission = await this.octokit.repos.getCollaboratorPermissionLevel({
          owner,
          repo: repoName,
          username
        });
        
        const perm = permission.data.user.permissions;
        return !!(perm?.admin || perm?.maintain || perm?.push);
      }
    } catch (error) {
      // User is not a collaborator
    }

    return false;
  }

  /**
   * Post approval/rejection comment to PR
   */
  private async postApprovalComment(
    repo: string,
    pr: number,
    approval: PendingApproval,
    action: 'approved' | 'rejected',
    user: string,
    reason?: string
  ): Promise<void> {
    const [owner, repoName] = approval.repo.split('/');
    
    const icon = action === 'approved' ? '✅' : '❌';
    let body = `${icon} **Patch ${action === 'approved' ? 'Approved' : 'Rejected'}**\n\n`;
    body += `**File**: \`${approval.file}:${approval.startLine}-${approval.endLine}\`\n`;
    body += `**${action === 'approved' ? 'Approved' : 'Rejected'} by**: @${user}\n`;
    body += `**Time**: ${new Date().toLocaleString()}\n`;
    
    if (reason) {
      body += `\n**Reason**: ${reason}\n`;
    }
    
    if (action === 'approved') {
      body += `\n_Patch will be applied in the next processing cycle._\n`;
    } else {
      body += `\n_Patch has been discarded._\n`;
    }

    try {
      await this.octokit.rest.issues.createComment({
        owner,
        repo: repoName,
        issue_number: pr,
        body
      });
      console.log(`[APPROVAL] Posted ${action} comment to ${repo}#${pr}`);
    } catch (error: any) {
      console.error(`[APPROVAL] Failed to post comment: ${error.message}`);
    }
  }

  /**
   * Load approvals from disk
   */
  private loadApprovals(): PendingApproval[] {
    if (!fs.existsSync(this.approvalsFile)) {
      return [];
    }
    
    try {
      const content = fs.readFileSync(this.approvalsFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error('[APPROVAL] Error loading approvals:', error);
      return [];
    }
  }

  /**
   * Save approvals to disk
   */
  private saveApprovals(approvals: PendingApproval[]): void {
    try {
      fs.writeFileSync(this.approvalsFile, JSON.stringify(approvals, null, 2));
      console.log(`[APPROVAL] Saved ${approvals.length} approvals`);
    } catch (error) {
      console.error('[APPROVAL] Error saving approvals:', error);
    }
  }

  /**
   * Load config
   */
  private loadConfig(): ApprovalConfig {
    const configPath = path.join(process.cwd(), '.pr-autopilot.config.json');
    
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(content).approval_settings || this.getDefaultConfig();
      } catch (error) {
        console.error('[APPROVAL] Error loading config:', error);
      }
    }
    
    return this.getDefaultConfig();
  }

  /**
   * Get default config
   */
  private getDefaultConfig(): ApprovalConfig {
    return {
      require_approval_for: {
        files: ['**/*.env*', '**/*secret*', '**/*credential*'],
        patterns: ['.*password.*', '.*api_key.*', '.*secret.*'],
        risk_keywords: ['security', 'vulnerability', 'authentication']
      },
      approval_methods: ['comment_command', 'reaction'],
      approvers: ['@owner', '@admin'],
      auto_approve_bots: ['prettier-bot', 'dependabot']
    };
  }

  /**
   * Check if string matches glob pattern
   */
  private matchesPattern(str: string, pattern: string): boolean {
    // Simple glob pattern matching
    const regexPattern = pattern
      .replace(/\*\*/g, '§§§')
      .replace(/\*/g, '[^/]*')
      .replace(/§§§/g, '.*');
    
    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(str);
  }

  /**
   * Generate approval report
   */
  generateReport(): string {
    const approvals = this.loadApprovals();
    
    let report = '# PR Autopilot Approval Report\n\n';
    report += `Generated: ${new Date().toLocaleString()}\n\n`;
    
    const byStatus = {
      pending: approvals.filter(a => a.status === 'pending').length,
      approved: approvals.filter(a => a.status === 'approved').length,
      rejected: approvals.filter(a => a.status === 'rejected').length
    };
    
    report += '## Summary\n';
    report += `- Pending: ${byStatus.pending}\n`;
    report += `- Approved: ${byStatus.approved}\n`;
    report += `- Rejected: ${byStatus.rejected}\n\n`;
    
    if (byStatus.pending > 0) {
      report += '## Pending Approvals\n\n';
      report += '| ID | Repo | PR | File | Reason | Created |\n';
      report += '|---|---|---|---|---|---|\n';
      
      for (const approval of approvals.filter(a => a.status === 'pending')) {
        report += `| ${approval.id.substring(0, 20)}... | ${approval.repo} | ${approval.pr} | ${approval.file}:${approval.startLine} | ${approval.reason} | ${new Date(approval.createdAt).toLocaleString()} |\n`;
      }
    }
    
    return report;
  }
}
