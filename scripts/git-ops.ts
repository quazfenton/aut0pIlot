import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const log = {
  warn: (msg: string) => console.log(`\x1b[33m[GIT]\x1b[0m ${msg}`),
  error: (msg: string) => console.log(`\x1b[31m[GIT]\x1b[0m ${msg}`),
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

    if (fs.existsSync(repoDir)) {
      try {
        gitExec('fetch origin', repoDir);
      } catch (e) {
        console.warn(`Warning: fetch failed for ${repo}, continuing with existing clone`);
      }
      return;
    }

    gitExec(`clone ${url} ${repoDir}`, this.workDir, { timeout: 120000 });
  }

  async fetch(repo: string): Promise<void> {
    gitExec('fetch origin', this.getRepoDir(repo));
  }

  async checkout(repo: string, ref: string): Promise<void> {
    const repoDir = this.getRepoDir(repo);
    try {
      gitExec(`checkout ${ref}`, repoDir);
    } catch {
      gitExec(`checkout -b ${ref} origin/${ref}`, repoDir);
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
      gitExec(`apply "${patchFile}"`, repoDir, { pipe: true });
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

  async push(repo: string, branch: string): Promise<void> {
    gitExec(`push -u origin ${branch}`, this.getRepoDir(repo), { timeout: 120000 });
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
    try {
      const output = gitExec('remote show origin', repoDir, { pipe: true });
      const match = output.match(/HEAD branch: (.*)/);
      if (match) return match[1];
    } catch {
      // ignore
    }

    // Fallback to checking local/common branches
    for (const b of ['main', 'master', 'develop', 'features']) {
      try {
        gitExec(`rev-parse origin/${b}`, repoDir, { pipe: true });
        return b;
      } catch {
        // ignore
      }
    }
    return 'main';
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
    } catch (error) {
      console.error('Error cleaning up GitOps work directory:', error);
    }
  }
}
