import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const log = {
  warn: (msg: string) => console.log(`\x1b[38;5;208m[GIT-WARN]\x1b[0m ${msg}`),    // Orange for warnings
  error: (msg: string) => console.log(`\x1b[31m[GIT-ERROR]\x1b[0m ${msg}`),         // Red for errors
  info: (msg: string) => console.log(`\x1b[36m[GIT-INFO]\x1b[0m ${msg}`),           // Cyan for info
  success: (msg: string) => console.log(`\x1b[32m[GIT-SUCCESS]\x1b[0m ${msg}`),      // Green for success
  checkout: (msg: string) => console.log(`\x1b[38;5;46m[GIT-CHECKOUT]\x1b[0m ${msg}`), // Bright green for checkout
  step: (msg: string) => console.log(`\x1b[38;5;226m[GIT-STEP]\x1b[0m ${msg}`),     // Bright yellow for steps
  debug: (msg: string) => console.log(`\x1b[2m[GIT-DEBUG]\x1b[0m ${msg}`),          // Dim gray for debug
};

function redactToken(msg: string): string {
  return msg.replace(/(https:\/\/x-access-token:)([^@]+)(@github\.com)/g, '$1***$3');
}

function gitExec(args: string, cwd: string, opts: { pipe?: boolean; timeout?: number } = {}): string {
  try {
    const result = execSync(`git ${args}`, {
      cwd,
      stdio: opts.pipe ? 'pipe' : 'ignore',
      timeout: opts.timeout ?? 60000,
    });
    return result ? result.toString().trim() : '';
  } catch (error: any) {
    throw new Error(redactToken(error.message || String(error)));
  }
}

// Track cloned repositories to avoid redundant clones in the same session
const clonedRepos = new Set<string>();

export class GitOps {
  private workDir: string;
  private token: string;

  constructor(token: string) {
    this.token = token;
    this.workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-autopilot-'));
  }

  async clone(repo: string): Promise<void> {
    const repoDir = this.getRepoDir(repo);
    const url = `https://x-access-token:${this.token}@github.com/${repo}.git`;

    if (clonedRepos.has(repo)) {
      // Repo already cloned in this session, just fetch latest
      if (fs.existsSync(repoDir)) {
        try {
          gitExec('fetch origin', repoDir);
        } catch (e) {
          console.warn(`Warning: fetch failed for ${repo}, continuing with existing clone`);
        }
      }
      return;
    }

    if (fs.existsSync(repoDir)) {
      try {
        gitExec('fetch origin', repoDir);
      } catch (e) {
        console.warn(`Warning: fetch failed for ${repo}, continuing with existing clone`);
      }
    } else {
      gitExec(`clone ${url} ${repoDir}`, this.workDir, { timeout: 120000 });
    }
    
    // Mark this repo as cloned in this session
    clonedRepos.add(repo);
  }

  async fetch(repo: string): Promise<void> {
    gitExec('fetch origin', this.getRepoDir(repo));
  }

  async checkout(repo: string, ref: string): Promise<void> {
    const repoDir = this.getRepoDir(repo);
    const isSha = /^[0-9a-f]{7,40}$/.test(ref);

    if (isSha) {
      // For commit SHAs: ensure the commit is fetched, then detach HEAD
      try {
        gitExec(`cat-file -t ${ref}`, repoDir, { pipe: true });
      } catch {
        // Commit not in local history — fetch it
        try {
          gitExec(`fetch origin ${ref}`, repoDir, { timeout: 120000 });
        } catch {
          // Some servers reject SHA fetches; deepen the shallow clone instead
          try {
            gitExec(`fetch --unshallow origin`, repoDir, { timeout: 120000 });
          } catch {
            // Already full or still can't find it — last resort full fetch
            try {
              gitExec(`fetch origin`, repoDir, { timeout: 120000 });
            } catch { /* give up fetching, checkout below will decide */ }
          }
        }
      }
      try {
        gitExec(`checkout ${ref}`, repoDir);
        log.checkout(`Checked out commit SHA: ${ref}`);
      } catch {
        log.warn(`Could not checkout ${ref}, staying on current HEAD`);
      }
    } else {
      // For branch names: try local checkout, then track from remote
      try {
        gitExec(`checkout ${ref}`, repoDir);
        log.checkout(`Checked out branch: ${ref}`);
      } catch {
        gitExec(`checkout -b ${ref} origin/${ref}`, repoDir);
        log.checkout(`Created and checked out new branch: ${ref}`);
      }
    }
  }

  async createAutofixBranch(repo: string, prNumber: number, iteration: number): Promise<string> {
    const repoDir = this.getRepoDir(repo);
    const branchName = `autopilot/pr-${prNumber}-iter-${iteration}`;

    try {
      gitExec(`rev-parse origin/${branchName}`, repoDir, { pipe: true });
      gitExec(`checkout ${branchName}`, repoDir);
      gitExec(`pull origin ${branchName}`, repoDir);
    } catch {
      gitExec(`checkout -b ${branchName}`, repoDir);
    }

    return branchName;
  }

  async getOrCreateHelperBranch(repo: string, prNumber: number, baseBranch: string, helperBranch?: string): Promise<string> {
    const repoDir = this.getRepoDir(repo);
    const branchName = helperBranch || `autopilot/pr-${prNumber}-fixes`;

    // If baseBranch looks like an autopilot branch, we need to find the real PR base
    // This happens when previous helper branches were pushed and became the PR head
    let effectiveBaseBranch = baseBranch;
    if (baseBranch.startsWith('autopilot/pr-') && baseBranch.endsWith('-fixes')) {
      // Extract the PR number from the branch name to verify
      const match = baseBranch.match(/autopilot\/pr-(\d+)-fixes/);
      if (match && parseInt(match[1], 10) !== prNumber) {
        // The PR head is pointing to another PR's helper branch
        // This is a GitHub state issue - try to find a real base branch
        log.warn(`PR ${prNumber} head is '${baseBranch}' which belongs to another PR. Attempting to find correct base.`);
        effectiveBaseBranch = await this.getDefaultBranch(repo);
        log.warn(`Using detected default branch as base: ${effectiveBaseBranch}`);
      }
    }

    const branchExistsLocally = (): boolean => {
      try {
        gitExec(`rev-parse --verify ${branchName}`, repoDir, { pipe: true });
        return true;
      } catch {
        return false;
      }
    };

    const branchExistsRemotely = (): boolean => {
      try {
        gitExec(`rev-parse origin/${branchName}`, repoDir, { pipe: true });
        return true;
      } catch {
        return false;
      }
    };

    try {
      // Fetch the effective base branch
      gitExec(`fetch origin ${effectiveBaseBranch}`, repoDir);

      if (branchExistsLocally()) {
        // Branch exists locally, checkout and rebase
        gitExec(`checkout ${branchName}`, repoDir);
        try {
          gitExec(`rebase origin/${effectiveBaseBranch}`, repoDir);
        } catch {
          // If rebase has conflicts, abort and recreate from current base
          gitExec(`rebase --abort`, repoDir);
          gitExec(`checkout ${effectiveBaseBranch}`, repoDir);
          gitExec(`branch -D ${branchName}`, repoDir);
          gitExec(`checkout -b ${branchName}`, repoDir);
        }
      } else if (branchExistsRemotely()) {
        // Branch exists on remote, fetch and checkout
        gitExec(`fetch origin ${branchName}`, repoDir);
        gitExec(`checkout -b ${branchName} origin/${branchName}`, repoDir);
        // Rebase on latest base branch
        try {
          gitExec(`rebase origin/${effectiveBaseBranch}`, repoDir);
        } catch {
          gitExec(`rebase --abort`, repoDir);
          gitExec(`checkout ${effectiveBaseBranch}`, repoDir);
          gitExec(`branch -D ${branchName}`, repoDir);
          gitExec(`checkout -b ${branchName}`, repoDir);
        }
      } else {
        // Create new branch from base
        gitExec(`checkout -b ${branchName} origin/${effectiveBaseBranch}`, repoDir);
      }

      return branchName;
    } catch (error: any) {
      throw new Error(`Failed to setup helper branch ${branchName}: ${error.message}`);
    }
  }

  async applyPatch(repo: string, patch: string): Promise<void> {
    const repoDir = this.getRepoDir(repo);
    const patchFile = path.join(this.workDir, `patch-${Date.now()}.patch`);
    fs.writeFileSync(patchFile, patch);

    try {
      try {
        gitExec(`apply "${patchFile}"`, repoDir, { pipe: true });
      } catch (error) {
        console.warn(`[GIT] Strict apply failed, trying fuzzy apply...`);
        // Try fuzzy apply with ignore-space-change, ignore-whitespace, and recount
        gitExec(`apply --ignore-space-change --ignore-whitespace --recount "${patchFile}"`, repoDir, { pipe: true });
      }
    } finally {
      if (fs.existsSync(patchFile)) fs.unlinkSync(patchFile);
    }
  }

  async commit(repo: string, message: string, author?: string): Promise<string> {
    const repoDir = this.getRepoDir(repo);

    gitExec('add -A', repoDir);

    const name = author || 'PR Autopilot';
    const email = author
      ? `${author}@users.noreply.github.com`
      : 'pr-autopilot[bot]@users.noreply.github.com';
    const safeMsg = message.replace(/"/g, '\\"');

    const output = gitExec(
      `-c user.name="${name}" -c user.email="${email}" commit -m "${safeMsg}"`,
      repoDir,
      { pipe: true }
    );

    const match = output.match(/\[[\w/.-]+ ([a-f0-9]+)\]/);
    return match ? match[1] : '';
  }

  /**
   * Execute git command with retry logic
   */
  private async gitExecWithRetry(args: string, cwd: string, opts: { pipe?: boolean; timeout?: number; retries?: number } = {}): Promise<string> {
    const maxRetries = opts.retries ?? 2;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = execSync(`git ${args}`, {
          cwd,
          stdio: opts.pipe ? 'pipe' : 'ignore',
          timeout: opts.timeout ?? 60000,
        });
        return result ? result.toString().trim() : '';
      } catch (error: any) {
        if (attempt === maxRetries) {
          // Last attempt failed, throw the error
          throw new Error(redactToken(error.message || String(error)));
        }
        
        // Wait before retrying (exponential backoff)
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, etc.
        console.log(`[GIT] Command failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: git ${args}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // This should never be reached
    throw new Error('Unexpected error in gitExecWithRetry');
  }

  async push(repo: string, branch: string): Promise<void> {
    const repoDir = this.getRepoDir(repo);
    
    // Try to push with retry logic
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      try {
        // First, ensure we have the latest changes from remote
        await this.gitExecWithRetry(`fetch origin`, repoDir);
        
        // Check if the remote branch has diverged
        try {
          const localSha = await this.gitExecWithRetry(`rev-parse HEAD`, repoDir, { pipe: true });
          const remoteSha = await this.gitExecWithRetry(`rev-parse origin/${branch}`, repoDir, { pipe: true });
          
          if (localSha !== remoteSha) {
            // Remote branch has changed, try to rebase
            console.log(`[GIT] Remote branch ${branch} has changed, rebasing...`);
            try {
              await this.gitExecWithRetry(`rebase origin/${branch}`, repoDir);
            } catch (rebaseErr) {
              console.log(`[GIT] Rebase failed, falling back to merge...`);
              await this.gitExecWithRetry(`merge origin/${branch}`, repoDir);
            }
          }
        } catch (fetchErr) {
          // Remote branch might not exist yet, which is fine
          console.log(`[GIT] Remote branch ${branch} may not exist yet, continuing...`);
        }
        
        // Perform the push
        await this.gitExecWithRetry(`push -u origin ${branch}`, repoDir, { timeout: 120000 });
        return; // Success, exit the retry loop
        
      } catch (error: any) {
        attempts++;
        console.log(`[GIT] Push attempt ${attempts} failed: ${error.message}`);
        
        if (attempts >= maxAttempts) {
          throw error; // Re-throw the error after max attempts
        }
        
        // Wait before retrying (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
      }
    }
  }

  async runCommand(
    repo: string, 
    command: string, 
    options?: { 
      env?: Record<string, string>; 
      timeout?: number; 
      cwd?: string;
    }
  ): Promise<{ success: boolean; output: string }> {
    const repoDir = this.getRepoDir(repo);
    const runDir = options?.cwd ? path.join(repoDir, options.cwd) : repoDir;
    
    try {
      const output = execSync(command, { 
        cwd: runDir, 
        stdio: 'pipe',
        env: { ...process.env, ...(options?.env || {}) },
        timeout: options?.timeout || 300000 // Default 5 mins
      }).toString();
      return { success: true, output };
    } catch (error: any) {
      return { success: false, output: error.stdout?.toString() || error.stderr?.toString() || error.message };
    }
  }

  async formatFile(repo: string, filePath: string): Promise<boolean> {
    const ext = path.extname(filePath).toLowerCase();
    const repoDir = this.getRepoDir(repo);
    const fullPath = path.join(repoDir, filePath);
    
    if (!fs.existsSync(fullPath)) return false;

    let command = '';
    if (['.js', '.ts', '.jsx', '.tsx', '.json', '.css', '.md'].includes(ext)) {
      command = `npx prettier --write "${filePath}"`;
    } else if (ext === '.py') {
      // Try ruff first, then black
      try {
        execSync(`ruff format "${filePath}"`, { cwd: repoDir, stdio: 'ignore' });
        return true;
      } catch {
        command = `black "${filePath}"`;
      }
    } else if (ext === '.go') {
      command = `gofmt -w "${filePath}"`;
    } else if (ext === '.rs') {
      command = `rustfmt "${filePath}"`;
    }

    if (command) {
      try {
        execSync(command, { cwd: repoDir, stdio: 'ignore' });
        return true;
      } catch (e) {
        log.warn(`Formatting failed for ${filePath}: ${String(e)}`);
        return false;
      }
    }
    
    return false;
  }

  async getDiff(repo: string, base: string, head?: string): Promise<string> {
    const headRef = head || 'HEAD';
    try {
      return gitExec(`diff ${base}...${headRef}`, this.getRepoDir(repo), { pipe: true });
    } catch {
      return '';
    }
  }

  async getCurrentCommit(repo: string): Promise<string> {
    return gitExec('rev-parse HEAD', this.getRepoDir(repo), { pipe: true });
  }

  async getDefaultBranch(repo: string): Promise<string> {
    const repoDir = this.getRepoDir(repo);

    // Primary: ask the remote what the HEAD branch is
    try {
      const output = gitExec('remote show origin', repoDir, { pipe: true });
      const match = output.match(/HEAD branch:\s*(.*)/);
      if (match && match[1].trim()) return match[1].trim();
    } catch {
      // ignore – may fail if remote is unreachable
    }

    // Secondary: inspect the symbolic ref that origin/HEAD points to
    try {
      const symRef = gitExec('symbolic-ref refs/remotes/origin/HEAD', repoDir, { pipe: true });
      const branch = symRef.replace('refs/remotes/origin/', '');
      if (branch) return branch;
    } catch {
      // ignore
    }

    // Fallback: probe common default branch names on the remote
    for (const b of ['features', 'dev', '000', 'main']) {
      try {
        gitExec(`rev-parse --verify origin/${b}`, repoDir, { pipe: true });
        return b;
      } catch {
        // ignore
      }
    }

    return 'master';
  }

  async getFileContent(repo: string, filePath: string, commit: string): Promise<string | null> {
    try {
      return gitExec(`show ${commit}:${filePath}`, this.getRepoDir(repo), { pipe: true });
    } catch {
      return null;
    }
  }

  private getRepoDir(repo: string): string {
    const [, repoName] = repo.split('/');
    return path.join(this.workDir, repoName);
  }

  cleanup(): void {
    try {
      if (fs.existsSync(this.workDir)) {
        fs.rmSync(this.workDir, { recursive: true, force: true });
      }
      // Clear the cloned repos cache on cleanup
      clonedRepos.clear();
    } catch (error) {
      console.error('Error cleaning up GitOps work directory:', error);
    }
  }
  
  // Method to clear the cloned repos cache without full cleanup
  clearRepoCache(): void {
    clonedRepos.clear();
  }
}
