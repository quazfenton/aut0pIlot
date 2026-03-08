import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import { GitOps } from './git-ops';
import { DiffUtils } from './utils/diff-utils';

const log = {
  header: (msg: string) => console.log(`\n\x1b[1;38;5;208m[QWEN-INTERACTIVE] ══ ${msg} ══\x1b[0m`),
  step: (msg: string) => console.log(`\x1b[32m[QWEN]\x1b[0m ${msg}`),
  detail: (msg: string) => console.log(`\x1b[2m[QWEN-DETAIL]\x1b[0m ${msg}`),
  warn: (msg: string) => console.log(`\x1b[1;33m[QWEN-WARN]\x1b[0m ${msg}`),
  error: (msg: string) => console.log(`\x1b[1;31m[QWEN-ERROR]\x1b[0m ${msg}`),
  success: (msg: string) => console.log(`\x1b[1;32m[QWEN-SUCCESS]\x1b[0m ${msg}`),
  thinking: (msg: string) => console.log(`\x1b[38;5;213m[QWEN-THINKING]\x1b[0m ${msg}`),
  diff: (msg: string) => console.log(`\x1b[38;5;245m[QWEN-DIFF]\x1b[0m ${msg}`),
  context: (msg: string) => console.log(`\x1b[38;5;117m[QWEN-CONTEXT]\x1b[0m ${msg}`),
};

export interface QwenInteractiveOptions {
  repo: string;
  pr: number;
  commitSha: string;
  targetFile: string;
  startLine: number;
  endLine: number;
  reviewComment: string;
  suggestions?: string[];
  proposedFixes?: string[];
  agentPrompt?: string;
  gitOps: GitOps;
  maxRounds?: number;
  timeoutMs?: number;
  enableFormatting?: boolean;
  useFullWorkspace?: boolean;
}

export interface QwenInteractiveResult {
  success: boolean;
  patch?: string;
  editedFiles: Array<{
    file: string;
    oldContent: string;
    newContent: string;
  }>;
  additionalEdits?: Array<{ file: string; reason: string }>;
  thinking?: string;
  rounds: number;
  error?: string;
  formattingApplied?: boolean;
  validationErrors?: string[];
}

interface QwenProcessResult {
  output: string;
  thinking: string;
  timedOut: boolean;
}

export class QwenInteractiveSession {
  private tempDir: string;
  private workDir: string;
  private thinkingLog: string[] = [];
  private rounds = 0;
  private repoDir: string | null = null;

  constructor(private options: QwenInteractiveOptions) {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-interactive-'));
    this.workDir = path.join(this.tempDir, 'workspace');
    fs.mkdirSync(this.workDir, { recursive: true });
  }

  /**
   * Execute interactive Qwen session
   * Full workspace mode: Qwen can read/edit any file in the project
   * Targeted mode: Only target file and closely related files are available
   */
  async execute(): Promise<QwenInteractiveResult> {
    log.header(`Starting interactive Qwen session for ${this.options.targetFile}`);
    log.step(`Mode: ${this.options.useFullWorkspace ? 'Full Workspace' : 'Targeted'}`);
    log.step(`Timeout: ${this.options.timeoutMs || 180000}ms`);

    try {
      await this.setupWorkspace();
      const prompt = this.buildPrompt();
      const result = await this.executeInteractive(prompt);
      return this.processResults(result);
    } catch (error: any) {
      log.error(`Session failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        editedFiles: [],
        rounds: this.rounds,
        thinking: this.thinkingLog.join('\n')
      };
    } finally {
      this.cleanup();
    }
  }

  /**
   * Setup workspace with project files
   */
  private async setupWorkspace(): Promise<void> {
    log.step('Setting up workspace');

    // Clone repository at specific commit
    await this.options.gitOps.clone(this.options.repo);
    await this.options.gitOps.checkout(this.options.repo, this.options.commitSha);

    this.repoDir = this.options.gitOps.getRepoDir(this.options.repo);

    // CRITICAL: Verify the repo directory exists before proceeding
    if (!this.repoDir || !fs.existsSync(this.repoDir)) {
      throw new Error(
        `Repository directory does not exist at ${this.repoDir}. ` +
        `GitOps workDir: ${this.options.gitOps.getWorkDir()}, ` +
        `Expected path: ${this.repoDir}`
      );
    }

    log.detail(`Repo directory verified at ${this.repoDir}`);

    if (this.options.useFullWorkspace !== false) {
      // Full workspace mode - copy entire project
      await this.copyFullProject();
    } else {
      // Targeted mode - copy only target file and related files
      await this.copyTargetedFiles();
    }

    // Create session context file
    this.createContextFile();

    // Create formatting config if enabled
    if (this.options.enableFormatting) {
      this.createFormattingConfig();
    }

    log.detail(`Workspace ready at ${this.workDir}`);
  }

  /**
   * Copy full project structure (excluding node_modules, .git, etc.)
   */
  private async copyFullProject(): Promise<void> {
    if (!this.repoDir) return;

    const exclude = ['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage'];

    const copyRecursive = async (src: string, dest: string): Promise<void> => {
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        const dirName = path.basename(src);
        if (exclude.includes(dirName)) return;

        fs.mkdirSync(dest, { recursive: true });
        const items = fs.readdirSync(src);
        for (const item of items) {
          await copyRecursive(path.join(src, item), path.join(dest, item));
        }
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    };

    log.step('Copying full project structure');
    await copyRecursive(this.repoDir, this.workDir);
  }

  /**
   * Copy only target file and intelligently discovered related files
   */
  private async copyTargetedFiles(): Promise<void> {
    if (!this.repoDir) return;

    const filesToCopy = new Set<string>();

    // Always copy target file
    filesToCopy.add(this.options.targetFile);

    // Discover related files
    const relatedFiles = await this.discoverRelatedFiles();
    for (const file of relatedFiles) {
      filesToCopy.add(file);
    }

    // Copy discovered files
    for (const relPath of filesToCopy) {
      const srcPath = path.join(this.repoDir, relPath);
      const destPath = path.join(this.workDir, relPath);

      if (fs.existsSync(srcPath)) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
      }
    }

    log.context(`Copied ${filesToCopy.size} files for context`);
  }

  /**
   * Discover files related to the target file
   */
  private async discoverRelatedFiles(): Promise<string[]> {
    if (!this.repoDir) return [];

    const relatedFiles: string[] = [];
    const targetExt = path.extname(this.options.targetFile);
    const targetDir = path.dirname(this.options.targetFile);
    const targetBase = path.basename(this.options.targetFile, targetExt);

    try {
      // 1. Files in same directory
      const sameDirFiles = execSync(
        `find "${this.repoDir}/${targetDir}" -maxdepth 1 -type f -name "*${targetExt}" 2>/dev/null`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();

      for (const file of sameDirFiles.split('\n').filter(f => f)) {
        const relPath = path.relative(this.repoDir, file);
        if (relPath !== this.options.targetFile) {
          relatedFiles.push(relPath);
        }
      }

      // 2. Type definition files
      const dtsFile = this.options.targetFile.replace(/\.ts$/, '.d.ts');
      if (dtsFile !== this.options.targetFile) {
        relatedFiles.push(dtsFile);
      }

      // 3. Test files
      const testPatterns = [
        `${targetDir}/*.test${targetExt}`,
        `${targetDir}/*.spec${targetExt}`,
        `tests/**/*${targetBase}*${targetExt}`,
        `test/**/*${targetBase}*${targetExt}`
      ];

      for (const pattern of testPatterns) {
        try {
          const testFiles = execSync(
            `find "${this.repoDir}" -path "*/${pattern}" 2>/dev/null | head -5`,
            { encoding: 'utf-8', timeout: 5000 }
          ).trim();

          for (const file of testFiles.split('\n').filter(f => f)) {
            relatedFiles.push(path.relative(this.repoDir, file));
          }
        } catch {
          // Ignore find errors
        }
      }

      // 4. Parse imports in target file
      const targetPath = path.join(this.repoDir, this.options.targetFile);
      if (fs.existsSync(targetPath)) {
        const content = fs.readFileSync(targetPath, 'utf-8');
        const importPaths = this.extractImportPaths(content);

        for (const importPath of importPaths) {
          if (importPath.startsWith('.')) {
            const resolved = path.resolve(path.dirname(targetPath), importPath);
            const withExt = resolved.endsWith(targetExt) ? resolved : resolved + targetExt;

            if (fs.existsSync(withExt)) {
              relatedFiles.push(path.relative(this.repoDir, withExt));
            }
          }
        }
      }

      // 5. Config files
      const configFiles = ['package.json', 'tsconfig.json', 'jsconfig.json', '.eslintrc.json'];
      for (const configFile of configFiles) {
        const configPath = path.join(this.repoDir, configFile);
        if (fs.existsSync(configPath)) {
          relatedFiles.push(configFile);
        }
      }

      // Limit to most relevant files
      return [...new Set(relatedFiles)].slice(0, 30);
    } catch (error: any) {
      log.warn(`Error discovering related files: ${error.message}`);
      return [];
    }
  }

  /**
   * Extract import paths from file content
   */
  private extractImportPaths(content: string): string[] {
    const imports: string[] = [];

    // Match: import ... from '...' or import ... from "..."
    const importRegex = /(?:import|from)\s+['"]([^'"]+)['"]/g;
    let match;

    while ((match = importRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }

    // Match: require('...') or require("...")
    const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

    while ((match = requireRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }

    return imports;
  }

  /**
   * Create session context file for Qwen
   */
  private createContextFile(): void {
    const context = this.buildPromptContent();
    fs.writeFileSync(path.join(this.workDir, 'CONTEXT.md'), context);
  }

  /**
   * Build the interactive prompt for Qwen
   */
  private buildPrompt(): string {
    return this.buildPromptContent();
  }

  /**
   * Build prompt content (used by both createContextFile and buildPrompt)
   */
  private buildPromptContent(): string {
    return `# Qwen Interactive Code Editing Session

## Task Overview
You are an expert code editor. Fix the review comment by editing code files.

## Review Comment
${this.options.reviewComment}

## Target File
- **File**: \`${this.options.targetFile}\`
- **Lines to modify**: ${this.options.startLine}-${this.options.endLine}

## Suggestions (from reviewer - use as guidance)
${this.options.suggestions?.map(s => `### Suggestion\n\`\`\`\n${s}\n\`\`\``).join('\n\n') || 'None provided'}

## Proposed Fixes (ready to apply or adapt)
${this.options.proposedFixes?.map(f => `### Proposed Fix\n\`\`\`\n${f}\n\`\`\``).join('\n\n') || 'None provided'}

${this.options.agentPrompt ? `## Agent Prompt\n${this.options.agentPrompt}\n` : ''}

## Your Capabilities
You have FULL freedom to:
- **Read** any file: \`read <filepath>\`
- **Edit** files directly: \`edit <filepath>\` or \`write <filepath>\`
- **Run commands**: \`bash <command>\`
- **View changes**: \`git diff\`
- **Format code**: \`npx prettier --write .\` (if prettier available)

## Instructions
1. Start by reading the target file to understand context
2. Analyze the review comment thoroughly
3. Learn from any suggested fixes (but improve if needed)
4. Make MINIMAL, targeted changes
5. If the fix requires changes in multiple files, make them
6. Preserve existing code style and indentation
7. Update imports if you add/remove exports
8. Run formatting before finishing (if enabled)

## Output Format
When done, output your changes as unified diff patches:

\`\`\`diff
--- a/path/to/file.ts
+++ b/path/to/file.ts
@@ -start,count +start,count @@
 context line
-removed line
+added line
 context line
\`\`\`

## Important Rules
- Do NOT output explanations outside the code blocks
- Do NOT use \`\`\`suggestion blocks - use \`\`\`diff
- Make sure patches apply cleanly with correct context
- Include 3 lines of context before/after changes
`;
  }

  /**
   * Create session context file for Qwen
   */
  private createContextFile(): void {
    const context = this.buildPromptContent();
    fs.writeFileSync(path.join(this.workDir, 'SESSION_CONTEXT.md'), context);
  }

  /**
   * Create formatting configuration
   */
  private createFormattingConfig(): void {
    // Prettier config
    const prettierConfig = {
      semi: true,
      singleQuote: true,
      tabWidth: 2,
      trailingComma: 'es5',
      printWidth: 100,
      arrowParens: 'always'
    };

    fs.writeFileSync(
      path.join(this.workDir, '.prettierrc'),
      JSON.stringify(prettierConfig, null, 2)
    );

    // Prettier ignore file
    fs.writeFileSync(
      path.join(this.workDir, '.prettierignore'),
      'node_modules\ndist\nbuild\ncoverage\n*.min.js\n'
    );
  }

  /**
   * Execute Qwen in interactive mode
   */
  private async executeInteractive(prompt: string): Promise<QwenProcessResult> {
    log.step('Executing Qwen interactive session');

    return new Promise((resolve, reject) => {
      const timeout = this.options.timeoutMs || 180000;
      let output = '';
      let thinking = '';
      let timedOut = false;
      let lastActivity = Date.now();

      // Write prompt to file
      const promptFile = path.join(this.workDir, 'PROMPT.md');
      fs.writeFileSync(promptFile, prompt);

      // Spawn Qwen process
      const qwen = spawn('qwen', ['--interactive', '--no-color'], {
        cwd: this.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NO_COLOR: '1',
          QWEN_WORKSPACE: this.workDir,
          QWEN_SESSION_ID: `pr-autopilot-${this.options.pr}-${Date.now()}`
        }
      });

      // Send initial prompt
      qwen.stdin.write(prompt + '\n');
      qwen.stdin.end();

      // Handle stdout
      qwen.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        lastActivity = Date.now();

        // Extract thinking blocks
        const thinkingMatches = text.match(/```thinking\n([\s\S]*?)\n```/g);
        if (thinkingMatches) {
          for (const match of thinkingMatches) {
            const content = match.replace(/```thinking\n|\n```/g, '');
            thinking += content + '\n\n';
            this.thinkingLog.push(content);
            log.thinking(`Thinking: ${content.substring(0, 200)}...`);
          }
        }

        // Log output (truncated for long outputs)
        const displayText = text.trim().substring(0, 500);
        if (displayText) {
          log.detail(displayText);
        }
      });

      // Handle stderr
      qwen.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        log.error(`Qwen stderr: ${text.trim()}`);
      });

      // Handle close
      qwen.on('close', (code: number | null) => {
        if (timedOut) return;

        if (code === 0) {
          this.rounds++;
          log.success(`Qwen session completed (round ${this.rounds})`);
          resolve({ output, thinking, timedOut: false });
        } else {
          reject(new Error(`Qwen exited with code ${code}`));
        }
      });

      // Handle errors
      qwen.on('error', (error: Error) => {
        if (timedOut) return;
        reject(new Error(`Failed to start Qwen: ${error.message}`));
      });

      // Activity timeout check
      const activityCheck = setInterval(() => {
        const inactivity = Date.now() - lastActivity;
        if (inactivity > timeout) {
          clearInterval(activityCheck);
          timedOut = true;
          qwen.kill();
          reject(new Error(`Qwen session timed out after ${timeout}ms`));
        }
      }, 5000);

      // Absolute timeout
      setTimeout(() => {
        if (!timedOut) {
          clearInterval(activityCheck);
          timedOut = true;
          qwen.kill();
          reject(new Error(`Qwen session exceeded maximum time limit (${timeout}ms)`));
        }
      }, timeout);
    });
  }

  /**
   * Process Qwen output and generate results
   */
  private async processResults(result: QwenProcessResult): Promise<QwenInteractiveResult> {
    log.step('Processing results and generating patches');

    if (!this.repoDir) {
      return {
        success: false,
        error: 'Repository not initialized',
        editedFiles: [],
        rounds: this.rounds,
        thinking: result.thinking
      };
    }

    // Find all modified files
    const modifiedFiles: Array<{ file: string; oldContent: string; newContent: string }> = [];
    const workspaceFiles = await this.getAllFiles(this.workDir);

    for (const workspaceFile of workspaceFiles) {
      const relPath = path.relative(this.workDir, workspaceFile);

      // Skip metadata files
      if (this.isMetadataFile(relPath)) continue;

      const originalPath = path.join(this.repoDir, relPath);
      if (!fs.existsSync(originalPath)) continue;

      const oldContent = fs.readFileSync(originalPath, 'utf-8');
      const newContent = fs.readFileSync(workspaceFile, 'utf-8');

      if (oldContent !== newContent) {
        modifiedFiles.push({
          file: relPath,
          oldContent,
          newContent
        });

        log.diff(`File modified: ${relPath}`);
      }
    }

    if (modifiedFiles.length === 0) {
      return {
        success: false,
        error: 'No files were modified by Qwen',
        editedFiles: [],
        rounds: this.rounds,
        thinking: result.thinking
      };
    }

    // Apply formatting if enabled
    let formattingApplied = false;
    if (this.options.enableFormatting) {
      formattingApplied = await this.applyFormatting();

      // If formatting was applied, re-read the formatted files
      if (formattingApplied) {
        for (const modified of modifiedFiles) {
          const formattedPath = path.join(this.workDir, modified.file);
          if (fs.existsSync(formattedPath)) {
            modified.newContent = fs.readFileSync(formattedPath, 'utf-8');
          }
        }
      }
    }

    // Generate unified diff patches using diff library
    let combinedPatch = '';
    const validationErrors: string[] = [];

    for (const modified of modifiedFiles) {
      try {
        const patch = DiffUtils.generateUnifiedDiff(modified.oldContent, modified.newContent, {
          oldFileName: modified.file,
          newFileName: modified.file,
          contextLines: 3
        });

        if (patch) {
          combinedPatch += patch + '\n\n';
        }
      } catch (error: any) {
        validationErrors.push(`Failed to generate diff for ${modified.file}: ${error.message}`);
      }
    }

    // Validate the combined patch
    if (combinedPatch) {
      const validation = DiffUtils.validateDiff(combinedPatch);

      if (!validation.valid) {
        validationErrors.push(...validation.errors);
        log.warn(`Patch validation warnings: ${validation.warnings.join(', ')}`);
      }

      // Try git apply --check for final validation
      const gitValid = await this.validatePatchWithGit(combinedPatch);
      if (!gitValid) {
        validationErrors.push('Patch failed git apply --check');
      }
    }

    // Build result
    return {
      success: modifiedFiles.length > 0 && validationErrors.length === 0,
      patch: combinedPatch.trim() || undefined,
      editedFiles: modifiedFiles,
      additionalEdits: modifiedFiles
        .filter(f => f.file !== this.options.targetFile)
        .map(f => ({ file: f.file, reason: 'Related file change' })),
      thinking: result.thinking,
      rounds: this.rounds,
      formattingApplied,
      validationErrors: validationErrors.length > 0 ? validationErrors : undefined
    };
  }

  /**
   * Check if file is metadata (not source code)
   */
  private isMetadataFile(relPath: string): boolean {
    const metadataFiles = [
      'SESSION_CONTEXT.md',
      'PROMPT.md',
      '.prettierrc',
      '.prettierignore',
      '.gitignore'
    ];

    return metadataFiles.some(f => relPath === f || relPath.endsWith(f));
  }

  /**
   * Apply code formatting with prettier
   */
  private async applyFormatting(): Promise<boolean> {
    log.step('Applying code formatting');

    try {
      execSync('npx prettier --write .', {
        cwd: this.workDir,
        stdio: 'ignore',
        timeout: 60000
      });

      log.success('Formatting applied');
      return true;
    } catch (error: any) {
      log.warn(`Formatting failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Validate patch with git apply --check
   */
  private async validatePatchWithGit(patch: string): Promise<boolean> {
    if (!this.repoDir) return false;

    const patchFile = path.join(this.tempDir, `validate-${Date.now()}.patch`);
    fs.writeFileSync(patchFile, patch);

    try {
      execSync(`git apply --check "${patchFile}"`, {
        cwd: this.repoDir,
        stdio: 'pipe',
        timeout: 10000
      });

      fs.unlinkSync(patchFile);
      return true;
    } catch (error: any) {
      const errorOutput = error.stderr?.toString() || error.stdout?.toString() || error.message;
      log.warn(`Git validation failed: ${errorOutput.substring(0, 200)}`);

      if (fs.existsSync(patchFile)) {
        fs.unlinkSync(patchFile);
      }

      return false;
    }
  }

  /**
   * Get all files in workspace directory
   */
  private async getAllFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    const walk = (current: string): void => {
      try {
        const items = fs.readdirSync(current);
        for (const item of items) {
          if (item === 'node_modules' || item === '.git') continue;

          const fullPath = path.join(current, item);
          const stat = fs.statSync(fullPath);

          if (stat.isDirectory()) {
            walk(fullPath);
          } else {
            files.push(fullPath);
          }
        }
      } catch (error) {
        // Ignore readdir errors
      }
    };

    walk(this.workDir);
    return files;
  }

  /**
   * Cleanup temporary files
   */
  private cleanup(): void {
    try {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
      log.detail('Cleaned up workspace');
    } catch (error) {
      log.warn('Failed to cleanup workspace');
    }
  }
}
