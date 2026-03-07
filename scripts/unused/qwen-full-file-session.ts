import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawn } from 'child_process';
import { PatchRequest, PatchResult } from './types';
import { GitOps } from './git-ops';
import { PatchErrorAnalyzer } from './patch-error-analyzer';

const log = {
  header: (msg: string) => console.log(`\n\x1b[1;38;5;208m[QWEN-FULL] ══ ${msg} ══\x1b[0m`),
  step: (msg: string) => console.log(`\x1b[32m[QWEN-FULL]\x1b[0m ${msg}`),
  detail: (msg: string) => console.log(`\x1b[2m[QWEN-DETAIL]\x1b[0m ${msg}`),
  warn: (msg: string) => console.log(`\x1b[1;33m[QWEN-WARN]\x1b[0m ${msg}`),
  error: (msg: string) => console.log(`\x1b[1;31m[QWEN-ERROR]\x1b[0m ${msg}`),
  success: (msg: string) => console.log(`\x1b[1;32m[QWEN-SUCCESS]\x1b[0m ${msg}`),
  thinking: (msg: string) => console.log(`\x1b[38;5;213m[QWEN-THINKING]\x1b[0m ${msg}`),
  diff: (msg: string) => console.log(`\x1b[38;5;245m[QWEN-DIFF]\x1b[0m ${msg}`),
  context: (msg: string) => console.log(`\x1b[38;5;117m[QWEN-CONTEXT]\x1b[0m ${msg}`),
};

export interface QwenFullFileOptions {
  repo: string;
  pr: number;
  commitSha: string;
  targetFile: string;
  startLine: number;
  endLine: number;
  reviewComment: string;
  previousAttempts?: Array<{
    patch: string;
    error: string;
    llm: string;
    validationDetails?: any;
  }>;
  suggestedFixes?: string[];
  committableSuggestions?: string[];
  agentPrompt?: string;
  gitOps: GitOps;
  maxRounds?: number;
  timeoutMs?: number;
}

export interface QwenFullFileResult {
  success: boolean;
  patch?: string;
  editedFiles?: Array<{ file: string; oldContent: string; newContent: string }>;
  thinking?: string;
  rounds: number;
  error?: string;
  additionalEdits?: Array<{ file: string; reason: string }>;
}

export class QwenFullFileSession {
  private tempDir: string;
  private workDir: string;
  private thinkingLog: string[] = [];
  private rounds = 0;
  private errorAnalyzer: PatchErrorAnalyzer;

  constructor(private options: QwenFullFileOptions) {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-full-'));
    this.workDir = path.join(this.tempDir, 'workspace');
    fs.mkdirSync(this.workDir, { recursive: true });
    this.errorAnalyzer = new PatchErrorAnalyzer();
  }

  /**
   * Execute a full-file editing session with Qwen CLI
   * This allows Qwen to read entire files, make multiple edits, and validate iteratively
   */
  async execute(): Promise<QwenFullFileResult> {
    log.header(`Starting full-file Qwen session for ${this.options.targetFile}`);
    log.step(`Max rounds: ${this.options.maxRounds || 5}, Timeout: ${this.options.timeoutMs || 300000}ms`);

    try {
      // Step 1: Setup workspace with full file context
      await this.setupWorkspace();

      // Step 2: Build comprehensive prompt with all context
      const prompt = this.buildComprehensivePrompt();

      // Step 3: Execute Qwen in interactive mode
      const result = await this.executeQwenSession(prompt);

      // Step 4: Validate and generate patches
      return await this.validateAndGeneratePatches(result);

    } catch (error: any) {
      log.error(`Session failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        rounds: this.rounds,
        thinking: this.thinkingLog.join('\n\n')
      };
    } finally {
      this.cleanup();
    }
  }

  private async setupWorkspace(): Promise<void> {
    log.step('Setting up workspace with full file context');

    // Clone repository at specific commit
    await this.options.gitOps.clone(this.options.repo);
    await this.options.gitOps.checkout(this.options.repo, this.options.commitSha);

    // Get repo directory
    const repoDir = this.options.gitOps.getRepoDir(this.options.repo);

    // Copy target file to workspace
    const targetFilePath = path.join(repoDir, this.options.targetFile);
    if (fs.existsSync(targetFilePath)) {
      const workspaceTargetPath = path.join(this.workDir, this.options.targetFile);
      fs.mkdirSync(path.dirname(workspaceTargetPath), { recursive: true });
      fs.copyFileSync(targetFilePath, workspaceTargetPath);
      log.detail(`Copied target file: ${this.options.targetFile}`);
    } else {
      log.warn(`Target file not found in repo: ${targetFilePath}`);
    }

    // Copy related files for broader context
    await this.copyRelatedFiles(repoDir);

    // Create a README with session context
    this.createSessionContextFile();

    log.detail(`Workspace ready at ${this.workDir}`);
  }

  private async copyRelatedFiles(repoDir: string): Promise<void> {
    const filesToCopy = [
      // Configuration files
      'package.json',
      'tsconfig.json',
      'pyproject.toml',
      'Cargo.toml',
      'go.mod',
      
      // Type definitions
      'scripts/types.ts',
      'src/types.ts',
      'lib/types.ts',
      
      // Related source files in same directory
      path.dirname(this.options.targetFile),
      
      // Test files for context
      `tests/${path.basename(this.options.targetFile, path.extname(this.options.targetFile))}.test.ts`,
      `test/${path.basename(this.options.targetFile, path.extname(this.options.targetFile))}.test.ts`,
    ];

    for (const filePattern of filesToCopy) {
      try {
        if (filePattern.includes('*') || filePattern.endsWith('/')) {
          // Directory or glob pattern - copy all files
          const dirPath = path.join(repoDir, filePattern.replace(/\/$/, ''));
          if (fs.existsSync(dirPath)) {
            const files = await this.getAllFilesInDir(dirPath);
            for (const file of files.slice(0, 20)) { // Limit to 20 files per directory
              const relativePath = path.relative(repoDir, file);
              await this.copyFileIfRelevant(repoDir, relativePath);
            }
          }
        } else {
          // Single file
          const fullPath = path.join(repoDir, filePattern);
          if (fs.existsSync(fullPath)) {
            const relativePath = filePattern;
            await this.copyFileIfRelevant(repoDir, relativePath);
          }
        }
      } catch (error) {
        // Ignore file copy errors
      }
    }

    log.detail(`Copied related files for context`);
  }

  private async getAllFilesInDir(dir: string): Promise<string[]> {
    const files: string[] = [];
    try {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && !item.includes('.git') && !item.includes('node_modules')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Ignore errors
    }
    return files;
  }

  private async copyFileIfRelevant(repoDir: string, relativePath: string): Promise<void> {
    const srcPath = path.join(repoDir, relativePath);
    const destPath = path.join(this.workDir, relativePath);

    if (fs.existsSync(srcPath)) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }

  private createSessionContextFile(): void {
    const contextFile = path.join(this.workDir, 'SESSION_CONTEXT.md');
    const context = `# Qwen Code Editing Session Context

## Task Overview
You are an expert code editor working in a CLI environment with full read/write access to the codebase.

## Target File
- **File**: \`${this.options.targetFile}\`
- **Lines to modify**: ${this.options.startLine}-${this.options.endLine}
- **Commit SHA**: ${this.options.commitSha}

## Review Comment
${this.options.reviewComment}

${this.options.suggestedFixes && this.options.suggestedFixes.length > 0 ? `
## Suggested Fixes (from reviewer)
${this.options.suggestedFixes.map((fix, i) => `### Fix ${i + 1}:\n\`\`\`\n${fix}\n\`\`\``).join('\n\n')}
` : ''}

${this.options.committableSuggestions && this.options.committableSuggestions.length > 0 ? `
## Committable Suggestions (ready to apply)
${this.options.committableSuggestions.map((suggestion, i) => `### Suggestion ${i + 1}:\n\`\`\`\n${suggestion}\n\`\`\``).join('\n\n')}
` : ''}

${this.options.agentPrompt ? `
## Agent Prompt
${this.options.agentPrompt}
` : ''}

${this.options.previousAttempts && this.options.previousAttempts.length > 0 ? `
## Previous Failed Attempts (learn from these mistakes)
${this.options.previousAttempts.map((attempt, i) => `
### Attempt ${i + 1} (${attempt.llm})
**Generated Patch**:
\`\`\`diff
${attempt.patch}
\`\`\`

**Error**: ${attempt.error}
`).join('\n\n')}
` : ''}

## Your Capabilities
- You can READ any file in the workspace using: \`read <filepath>\`
- You can EDIT files using: \`edit <filepath>\` or \`write <filepath>\`
- You can run commands: \`bash <command>\`
- You can validate changes: \`git diff\`, \`git apply --check\`

## Instructions
1. Start by reading the target file to understand the full context
2. Analyze the review comment and understand what needs to be fixed
3. Learn from previous failed attempts (if any)
4. Make minimal, targeted changes that address the review comment
5. Use the suggested fixes as inspiration, but improve upon them if needed
6. Validate your changes work correctly
7. When done, output the final patches in unified diff format

## Output Format
When you're done editing, output your changes as unified diff patches:
\`\`\`diff
--- a/path/to/file
+++ b/path/to/file
@@ -start,count +start,count @@
 context line
-removed line
+added line
 context line
\`\`\`
`;

    fs.writeFileSync(contextFile, context);
  }

  private buildComprehensivePrompt(): string {
    let prompt = `# Interactive Code Editing Session

You are Qwen, an expert code editor. You have full access to the codebase and can make iterative edits.

## Context
- **Repository**: ${this.options.repo}
- **PR**: #${this.options.pr}
- **Target File**: ${this.options.targetFile}
- **Lines**: ${this.options.startLine}-${this.options.endLine}

## Review Comment to Address
${this.options.reviewComment}

## Available Commands
- \`read <file>\` - Read file contents
- \`edit <file>\` - Edit a file interactively
- \`write <file>\` - Write content to a file
- \`bash <command>\` - Run shell commands
- \`git diff\` - See your changes
- \`git apply --check <patch>\` - Validate a patch

## Session Rules
1. Read the target file first to understand context
2. Make minimal, focused changes
3. Validate each change before moving on
4. Learn from any errors
5. Output final patches in unified diff format when done

Start by reading the target file: \`${this.options.targetFile}\``;

    return prompt;
  }

  private async executeQwenSession(prompt: string): Promise<{ output: string; thinking: string }> {
    log.step('Executing Qwen interactive session');

    return new Promise((resolve, reject) => {
      const timeout = this.options.timeoutMs || 300000;
      let output = '';
      let thinking = '';
      let lastActivity = Date.now();

      // Write prompt to file for Qwen to read
      const promptFile = path.join(this.workDir, 'PROMPT.md');
      fs.writeFileSync(promptFile, prompt);

      // Spawn Qwen CLI process
      const qwenProcess = spawn('qwen', ['--interactive', '--no-color'], {
        cwd: this.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          QWEN_SESSION_ID: `pr-autopilot-${this.options.pr}-${Date.now()}`,
          QWEN_WORKSPACE: this.workDir,
          NO_COLOR: '1'
        }
      });

      // Send initial prompt
      qwenProcess.stdin.write(prompt + '\n');

      // Handle stdout
      qwenProcess.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        lastActivity = Date.now();

        // Extract thinking blocks
        const thinkingMatches = text.match(/```thinking\n([\s\S]*?)\n```/g);
        if (thinkingMatches) {
          for (const match of thinkingMatches) {
            const thinkingContent = match.replace(/```thinking\n|\n```/g, '');
            thinking += thinkingContent + '\n\n';
            this.thinkingLog.push(thinkingContent);
            log.thinking(`Thinking: ${thinkingContent.substring(0, 200)}...`);
          }
        }

        // Log output
        log.detail(text.trim().substring(0, 500));
      });

      // Handle stderr
      qwenProcess.stderr.on('data', (data) => {
        const text = data.toString();
        log.error(`Qwen stderr: ${text.trim()}`);
      });

      // Handle process exit
      qwenProcess.on('close', (code) => {
        if (code === 0) {
          this.rounds++;
          log.success(`Qwen session completed in round ${this.rounds}`);
          resolve({ output, thinking });
        } else {
          reject(new Error(`Qwen session exited with code ${code}`));
        }
      });

      qwenProcess.on('error', (error) => {
        reject(new Error(`Failed to start Qwen: ${error.message}`));
      });

      // Timeout handling
      const timeoutInterval = setInterval(() => {
        const inactivity = Date.now() - lastActivity;
        if (inactivity > timeout) {
          clearInterval(timeoutInterval);
          qwenProcess.kill();
          reject(new Error(`Qwen session timed out after ${timeout}ms`));
        }
      }, 5000);

      // Also set absolute timeout
      setTimeout(() => {
        clearInterval(timeoutInterval);
        qwenProcess.kill();
        reject(new Error(`Qwen session exceeded maximum time limit`));
      }, timeout);
    });
  }

  private async validateAndGeneratePatches(result: { output: string; thinking: string }): Promise<QwenFullFileResult> {
    log.step('Validating results and generating patches');

    const editedFiles: Array<{ file: string; oldContent: string; newContent: string }> = [];
    const additionalEdits: Array<{ file: string; reason: string }> = [];

    // Get repo directory for comparison
    const repoDir = this.options.gitOps.getRepoDir(this.options.repo);

    // Find all modified files in workspace
    const workspaceFiles = await this.getAllFilesInWorkspace();

    for (const workspaceFile of workspaceFiles) {
      const relativePath = path.relative(this.workDir, workspaceFile);

      // Skip metadata files
      if (relativePath.includes('SESSION_CONTEXT.md') || 
          relativePath.includes('PROMPT.md') ||
          relativePath.includes('.git')) {
        continue;
      }

      const originalFile = path.join(repoDir, relativePath);

      if (fs.existsSync(originalFile)) {
        const originalContent = fs.readFileSync(originalFile, 'utf8');
        const editedContent = fs.readFileSync(workspaceFile, 'utf8');

        if (originalContent !== editedContent) {
          editedFiles.push({
            file: relativePath,
            oldContent: originalContent,
            newContent: editedContent
          });

          log.detail(`File modified: ${relativePath}`);

          if (relativePath !== this.options.targetFile) {
            additionalEdits.push({
              file: relativePath,
              reason: 'Modified as part of implementing the fix'
            });
          }
        }
      }
    }

    if (editedFiles.length === 0) {
      return {
        success: false,
        error: 'No files were modified by Qwen',
        rounds: this.rounds,
        thinking: result.thinking
      };
    }

    // Generate unified diff patches for each modified file
    let combinedPatch = '';
    for (const editedFile of editedFiles) {
      const patch = this.generateUnifiedDiff(
        editedFile.file,
        editedFile.oldContent,
        editedFile.newContent
      );
      if (patch) {
        combinedPatch += patch + '\n\n';
        log.diff(`Generated patch for ${editedFile.file}`);
      }
    }

    // Validate the combined patch
    if (combinedPatch) {
      const isValid = await this.validatePatch(combinedPatch);
      if (!isValid) {
        log.warn('Generated patch failed validation, but returning anyway for manual review');
      }
    }

    return {
      success: editedFiles.length > 0,
      patch: combinedPatch.trim(),
      editedFiles,
      thinking: result.thinking,
      rounds: this.rounds,
      additionalEdits
    };
  }

  private async getAllFilesInWorkspace(): Promise<string[]> {
    const files: string[] = [];

    const walk = (dir: string) => {
      try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          if (item === 'node_modules' || item === '.git') continue;

          const fullPath = path.join(dir, item);
          const stat = fs.statSync(fullPath);

          if (stat.isDirectory()) {
            walk(fullPath);
          } else if (stat.isFile()) {
            files.push(fullPath);
          }
        }
      } catch (error) {
        // Ignore errors
      }
    };

    walk(this.workDir);
    return files;
  }

  private generateUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    // Use git diff if available for better quality
    try {
      const oldFile = path.join(this.tempDir, `old-${Date.now()}.txt`);
      const newFile = path.join(this.tempDir, `new-${Date.now()}.txt`);

      fs.writeFileSync(oldFile, oldContent);
      fs.writeFileSync(newFile, newContent);

      const diff = execSync(`git diff --no-index --patch --unified=3 "${oldFile}" "${newFile}"`, {
        stdio: 'pipe'
      }).toString();

      // Fix file paths in diff output
      const lines = diff.split('\n');
      const fixedLines = lines.map((line: string) => {
        if (line.startsWith('--- ')) return `--- a/${filePath}`;
        if (line.startsWith('+++ ')) return `+++ b/${filePath}`;
        return line;
      });

      return fixedLines.join('\n');
    } catch (error: any) {
      // git diff returns 1 if there are differences
      if (error.status === 1 && error.stdout) {
        const diff = error.stdout.toString();
        const lines = diff.split('\n');
        const fixedLines = lines.map((line: string) => {
          if (line.startsWith('--- ')) return `--- a/${filePath}`;
          if (line.startsWith('+++ ')) return `+++ b/${filePath}`;
          return line;
        });
        return fixedLines.join('\n');
      }

      // Fallback to simple diff
      log.warn('Git diff failed, using fallback diff generation');
      return this.generateSimpleDiff(filePath, oldLines, newLines);
    }
  }

  private generateSimpleDiff(filePath: string, oldLines: string[], newLines: string[]): string {
    // Simple unified diff generation
    let patch = `--- a/${filePath}\n`;
    patch += `+++ b/${filePath}\n`;

    // Find the first and last changed lines
    let firstChange = -1;
    let lastChange = -1;

    for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
      if (oldLines[i] !== newLines[i]) {
        if (firstChange === -1) firstChange = i;
        lastChange = i;
      }
    }

    if (firstChange === -1) {
      return ''; // No changes
    }

    // Add context (3 lines before and after)
    const contextBefore = 3;
    const contextAfter = 3;

    const startLine = Math.max(0, firstChange - contextBefore);
    const endLine = Math.min(oldLines.length, lastChange + contextAfter + 1);

    const oldCount = endLine - startLine;
    const newCount = oldCount + (newLines.length - oldLines.length);

    patch += `@@ -${startLine + 1},${oldCount} +${startLine + 1},${newCount} @@\n`;

    // Add context lines before
    for (let i = startLine; i < firstChange; i++) {
      patch += ` ${oldLines[i]}\n`;
    }

    // Add changes (simplified - just show additions/removals)
    for (let i = firstChange; i <= lastChange && i < oldLines.length; i++) {
      patch += `-${oldLines[i]}\n`;
    }

    for (let i = firstChange; i <= lastChange && i < newLines.length; i++) {
      patch += `+${newLines[i]}\n`;
    }

    // Add context lines after
    for (let i = Math.max(firstChange, lastChange + 1); i < endLine && i < oldLines.length; i++) {
      patch += ` ${oldLines[i]}\n`;
    }

    return patch;
  }

  private async validatePatch(patch: string): Promise<boolean> {
    try {
      const patchFile = path.join(this.tempDir, `validation-${Date.now()}.patch`);
      fs.writeFileSync(patchFile, patch);

      try {
        execSync(`git apply --check "${patchFile}"`, {
          cwd: this.options.gitOps.getRepoDir(this.options.repo),
          stdio: 'pipe',
          timeout: 10000
        });
        return true;
      } catch (error: any) {
        const errorOutput = error.stderr?.toString() || error.message;
        log.warn(`Patch validation failed: ${errorOutput}`);
        return false;
      } finally {
        if (fs.existsSync(patchFile)) {
          fs.unlinkSync(patchFile);
        }
      }
    } catch (error: any) {
      log.error(`Validation setup failed: ${error.message}`);
      return false;
    }
  }

  private cleanup(): void {
    try {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
      log.detail('Cleaned up temporary workspace');
    } catch (error) {
      log.warn('Failed to cleanup workspace');
    }
  }
}
