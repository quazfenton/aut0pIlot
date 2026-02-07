import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
export class GitOps {
    workDir;
    token;
    constructor(token) {
        this.token = token;
        this.workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-autopilot-'));
    }
    /**
     * Clone a repository
     */
    async clone(repo) {
        const repoDir = this.getRepoDir(repo);
        const url = `https://x-access-token:${this.token}@github.com/${repo}.git`;
        if (fs.existsSync(repoDir)) {
            execSync(`git fetch origin`, {
                cwd: repoDir,
                stdio: 'ignore',
            });
            return;
        }
        execSync(`git clone ${url} ${repoDir}`, {
            cwd: this.workDir,
            stdio: 'ignore',
        });
    }
    /**
     * Fetch the latest changes
     */
    async fetch(repo) {
        const repoDir = this.getRepoDir(repo);
        execSync(`git fetch origin`, {
            cwd: repoDir,
            stdio: 'ignore',
        });
    }
    /**
     * Checkout a branch or commit
     */
    async checkout(repo, ref) {
        const repoDir = this.getRepoDir(repo);
        execSync(`git checkout ${ref}`, {
            cwd: repoDir,
            stdio: 'ignore',
        });
    }
    /**
     * Create a new branch for applying fixes
     */
    async createAutofixBranch(repo, prNumber, iteration) {
        const repoDir = this.getRepoDir(repo);
        const branchName = `autopilot/pr-${prNumber}-iter-${iteration}`;
        try {
            // Check if branch exists
            execSync(`git rev-parse origin/${branchName}`, {
                cwd: repoDir,
                stdio: 'pipe',
            });
            // Branch exists, checkout it
            execSync(`git checkout ${branchName}`, {
                cwd: repoDir,
                stdio: 'ignore',
            });
            // Pull latest
            execSync(`git pull origin ${branchName}`, {
                cwd: repoDir,
                stdio: 'ignore',
            });
        }
        catch {
            // Branch doesn't exist, create it
            execSync(`git checkout -b ${branchName}`, {
                cwd: repoDir,
                stdio: 'ignore',
            });
        }
        return branchName;
    }
    /**
     * Apply a patch to the working directory
     */
    async applyPatch(repo, patch) {
        const repoDir = this.getRepoDir(repo);
        // Write patch to temp file
        const patchFile = path.join(this.workDir, `patch-${Date.now()}.patch`);
        fs.writeFileSync(patchFile, patch);
        try {
            execSync(`git apply ${patchFile}`, {
                cwd: repoDir,
                stdio: 'pipe',
            });
        }
        finally {
            fs.unlinkSync(patchFile);
        }
    }
    /**
     * Commit changes
     */
    async commit(repo, message, author) {
        const repoDir = this.getRepoDir(repo);
        // Stage all changes
        execSync(`git add -A`, {
            cwd: repoDir,
            stdio: 'ignore',
        });
        // Configure git author
        const authorConfig = author
            ? `-c user.name="${author}" -c user.email="${author}@users.noreply.github.com"`
            : '-c user.name="PR Autopilot" -c user.email="pr-autopilot[bot]@users.noreply.github.com"';
        // Commit
        const commitOutput = execSync(`git ${authorConfig} commit -m "${message.replace(/"/g, '\\"')}"`, {
            cwd: repoDir,
            stdio: 'pipe',
        }).toString();
        // Extract commit SHA
        const match = commitOutput.match(/\[([a-f0-9]+)\]/);
        return match ? match[1] : '';
    }
    /**
     * Push changes to remote
     */
    async push(repo, branch) {
        const repoDir = this.getRepoDir(repo);
        execSync(`git push -u origin ${branch}`, {
            cwd: repoDir,
            stdio: 'ignore',
        });
    }
    /**
     * Get the diff of changes
     */
    async getDiff(repo, base, head) {
        const repoDir = this.getRepoDir(repo);
        const headRef = head || 'HEAD';
        try {
            return execSync(`git diff ${base}...${headRef}`, {
                cwd: repoDir,
                stdio: 'pipe',
            }).toString();
        }
        catch {
            return '';
        }
    }
    /**
     * Get the current commit SHA
     */
    async getCurrentCommit(repo) {
        const repoDir = this.getRepoDir(repo);
        return execSync('git rev-parse HEAD', {
            cwd: repoDir,
            stdio: 'pipe',
        }).toString().trim();
    }
    /**
     * Get file content at a specific commit
     */
    async getFileContent(repo, filePath, commit) {
        const repoDir = this.getRepoDir(repo);
        try {
            return execSync(`git show ${commit}:${filePath}`, {
                cwd: repoDir,
                stdio: 'pipe',
            }).toString();
        }
        catch {
            return null;
        }
    }
    /**
     * Get repository directory path
     */
    getRepoDir(repo) {
        const [, repoName] = repo.split('/');
        return path.join(this.workDir, repoName);
    }
    /**
     * Clean up working directory
     */
    cleanup() {
        try {
            if (fs.existsSync(this.workDir)) {
                fs.rmSync(this.workDir, { recursive: true, force: true });
            }
        }
        catch (error) {
            console.error('Error cleaning up GitOps work directory:', error);
        }
    }
}
