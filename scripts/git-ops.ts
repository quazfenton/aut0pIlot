import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';

const execAsync = promisify(require('child_process').exec);

// Helper function to safely execute git commands with spawn
async function safeGitExec(command: string[], cwd: string, options: { stdio?: any, timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', command, {
      cwd,
      stdio: options.stdio || 'pipe',
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out: git ${command.join(' ')}`));
    }, options.timeout || 30000);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Command failed with code ${code}: git ${command.join(' ')}\nStderr: ${stderr}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export class GitOps {
  private workDir: string;
  private token: string;

  constructor(token: string) {
    this.token = token;
    this.workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-autopilot-'));
  }

  /**
   * Clone a repository
   */
  async clone(repo: string): Promise<void> {
    const repoDir = this.getRepoDir(repo);
    const url = `https://x-access-token:${this.token}@github.com/${repo}.git`;

    if (fs.existsSync(repoDir)) {
      await safeGitExec(['fetch', 'origin'], repoDir, { stdio: 'ignore' });
      return;
    }

    await safeGitExec(['clone', url, repoDir], this.workDir, { stdio: 'ignore' });
  }

  /**
   * Fetch the latest changes
   */
  async fetch(repo: string): Promise<void> {
    const repoDir = this.getRepoDir(repo);
    await safeGitExec(['fetch', 'origin'], repoDir, { stdio: 'ignore' });
  }

  /**
   * Checkout a branch or commit
   */
  async checkout(repo: string, ref: string): Promise<void> {
    const repoDir = this.getRepoDir(repo);
    await safeGitExec(['checkout', ref], repoDir, { stdio: 'ignore' });
  }

  /**
   * Create a new branch for applying fixes
   */
  async createAutofixBranch(repo: string, prNumber: number, iteration: number): Promise<string> {
    const repoDir = this.getRepoDir(repo);
    const branchName = `autopilot/pr-${prNumber}-iter-${iteration}`;

    try {
      // Check if branch exists
      await safeGitExec(['rev-parse', `origin/${branchName}`], repoDir, { stdio: 'pipe' });
      // Branch exists, checkout it
      await safeGitExec(['checkout', branchName], repoDir, { stdio: 'ignore' });
      // Pull latest
      await safeGitExec(['pull', 'origin', branchName], repoDir, { stdio: 'ignore' });
    } catch {
      // Branch doesn't exist, create it
      await safeGitExec(['checkout', '-b', branchName], repoDir, { stdio: 'ignore' });
    }

    return branchName;
  }

  /**
   * Apply a patch to the working directory
   */
  async applyPatch(repo: string, patch: string): Promise<void> {
    const repoDir = this.getRepoDir(repo);

    // Write patch to temp file
    const patchFile = path.join(this.workDir, `patch-${Date.now()}.patch`);
    fs.writeFileSync(patchFile, patch);

    try {
      // Sanitize the patch file path to prevent command injection
      const sanitizedPatchFile = path.resolve(this.workDir, path.basename(patchFile));
      await safeGitExec(['apply', sanitizedPatchFile], repoDir, { stdio: 'pipe' });
    } finally {
      fs.unlinkSync(patchFile);
    }
  }

  /**
   * Commit changes
   */
  async commit(repo: string, message: string, author?: string): Promise<string> {
    const repoDir = this.getRepoDir(repo);

    // Stage all changes
    await safeGitExec(['add', '-A'], repoDir, { stdio: 'ignore' });

    // Configure git author
    const authorConfig = author
      ? ['-c', `user.name="${author}"`, '-c', `user.email="${author}@users.noreply.github.com"`]
      : ['-c', 'user.name="PR Autopilot"', '-c', 'user.email="pr-autopilot[bot]@users.noreply.github.com"'];

    // Sanitize the commit message to prevent command injection
    const sanitizedMessage = message.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    
    // Commit - we need to use the spread operator to pass arguments separately
    const args = [...authorConfig, 'commit', '-m', sanitizedMessage];
    const commitOutput = await safeGitExec(args, repoDir, { stdio: 'pipe' });

    // Extract commit SHA
    const match = commitOutput.match(/\[([a-f0-9]+)\]/);
    return match ? match[1] : '';
  }

  /**
   * Push changes to remote
   */
  async push(repo: string, branch: string): Promise<void> {
    const repoDir = this.getRepoDir(repo);
    await safeGitExec(['push', '-u', 'origin', branch], repoDir, { stdio: 'ignore' });
  }

  /**
   * Get the diff of changes
   */
  async getDiff(repo: string, base: string, head?: string): Promise<string> {
    const repoDir = this.getRepoDir(repo);
    const headRef = head || 'HEAD';

    try {
      return await safeGitExec(['diff', `${base}...${headRef}`], repoDir, { stdio: 'pipe' });
    } catch {
      return '';
    }
  }

  /**
   * Get the current commit SHA
   */
  async getCurrentCommit(repo: string): Promise<string> {
    const repoDir = this.getRepoDir(repo);
    return (await safeGitExec(['rev-parse', 'HEAD'], repoDir, { stdio: 'pipe' })).trim();
  }

  /**
   * Get file content at a specific commit
   */
  async getFileContent(repo: string, filePath: string, commit: string): Promise<string | null> {
    const repoDir = this.getRepoDir(repo);
    try {
      // Sanitize inputs to prevent command injection
      const sanitizedCommit = commit.replace(/[^a-zA-Z0-9\-_:.]/g, '');
      const sanitizedFilePath = filePath.replace(/[^a-zA-Z0-9\-_./]/g, '');
      
      return await safeGitExec(['show', `${sanitizedCommit}:${sanitizedFilePath}`], repoDir, { stdio: 'pipe' });
    } catch {
      return null;
    }
  }

  /**
   * Get repository directory path
   */
  private getRepoDir(repo: string): string {
    const [, repoName] = repo.split('/');
    return path.join(this.workDir, repoName);
  }

  /**
   * Clean up working directory
   */
  cleanup(): void {
    try {
      if (fs.existsSync(this.workDir)) {
        fs.rmSync(this.workDir, { recursive: true, force: true });
      }
    } catch (error) {
      console.error('Error cleaning up GitOps work directory:', error);
    }
  }
}
