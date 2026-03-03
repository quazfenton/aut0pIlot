import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawn } from 'child_process';
import { PatchRequest, PatchResult } from './types';
import { GitOps } from './git-ops';

const log = {
  header: (msg: string) => console.log(`\x1b[1;38;5;208m[QWEN-CLI] ══ ${msg} ══\x1b[0m`),
  step: (msg: string) => console.log(`\x1b[32m[QWEN-CLI]\x1b[0m ${msg}`),
  detail: (msg: string) => console.log(`\x1b[2m[QWEN-DETAIL]\x1b[0m ${msg}`),
  warn: (msg: string) => console.log(`\x1b[1;33m[QWEN-WARN]\x1b[0m ${msg}`),
  error: (msg: string) => console.log(`\x1b[1;31m[QWEN-ERROR]\x1b[0m ${msg}`),
  success: (msg: string) => console.log(`\x1b[1;32m[QWEN-SUCCESS]\x1b[0m ${msg}`),
  thinking: (msg: string) => console.log(`\x1b[38;5;213m[QWEN-THINKING]\x1b[0m ${msg}`),
  diff: (msg: string) => console.log(`\x1b[38;5;245m[QWEN-DIFF]\x1b[0m ${msg}`),
};

export interface EnhancedQwenOptions {
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
  }>;
  suggestedFixes?: string[];
  committableSuggestions?: string[];
  gitOps: GitOps;
}

export interface EnhancedQwenResult {
  success: boolean;
  patch?: string;
  editedFiles?: Array<{ file: string; content: string }>;
  thinking?: string;
  rounds: number;
  error?: string;
  validationDetails?: {
    appliedFiles: string[];
    failedFiles: Array<{ file: string; error: string }>;
    warnings: string[];
  };
}

export class EnhancedQwenSession {
  private tempDir: string;
  private workDir: string;
  private thinkingLog: string[] = [];
  private rounds = 0;

  constructor(private options: EnhancedQwenOptions) {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enhanced-qwen-'));
    this.workDir = path.join(this.tempDir, 'workspace');
    fs.mkdirSync(this.workDir, { recursive: true });
  }

  async execute(): Promise<EnhancedQwenResult> {
    log.header(`Starting enhanced Qwen CLI session for ${this.options.targetFile}`);
    
    try {
      // Setup workspace
      await this.setupWorkspace();
      
      // Build comprehensive prompt
      const prompt = this.buildComprehensivePrompt();
      
      // Execute Qwen in interactive CLI mode
      const result = await this.executeQwenCLI(prompt);
      
      // Validate and collect results
      return await this.validateAndCollectResults(result);
      
    } catch (error: any) {
      log.error(`Session failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        rounds: this.rounds,
        thinking: this.thinkingLog.join('\n')
      };
    } finally {
      this.cleanup();
    }
  }

  private async setupWorkspace(): Promise<void> {
    log.step('Setting up workspace');
    
    // Clone repository at specific commit
    await this.options.gitOps.clone(this.options.repo);
    await this.options.gitOps.checkout(this.options.repo, this.options.commitSha);
    
    // Copy relevant files to workspace
    const repoDir = this.options.gitOps.getRepoDir(this.options.repo);
    const targetFilePath = path.join(repoDir, this.options.targetFile);
    
    if (fs.existsSync(targetFilePath)) {
      const workspaceTargetPath = path.join(this.workDir, this.options.targetFile);
      fs.mkdirSync(path.dirname(workspaceTargetPath), { recursive: true });
      fs.copyFileSync(targetFilePath, workspaceTargetPath);
    }
    
    // Copy related files for context
    await this.copyRelatedFiles(repoDir);
    
    log.detail(`Workspace ready at ${this.workDir}`);
  }

  private async copyRelatedFiles(repoDir: string): Promise<void> {
    // Copy configuration files, types, and related source files
    const relatedPatterns = [
      'package.json',
      'tsconfig.json',
      'scripts/types.ts',
      'scripts/*.ts',
      'tests/**/*.ts'
    ];

    for (const pattern of relatedPatterns) {
      try {
        const files = await this.findFiles(repoDir, pattern);
        for (const file of files) {
          const relativePath = path.relative(repoDir, file);
          const workspacePath = path.join(this.workDir, relativePath);
          fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
          fs.copyFileSync(file, workspacePath);
        }
      } catch (error) {
        // Ignore file copy errors
      }
    }
  }

  private async findFiles(dir: string, pattern: string): Promise<string[]> {
    // Simple file finding implementation
    const results: string[] = [];
    const walk = (currentDir: string) => {
      const items = fs.readdirSync(currentDir);
      for (const item of items) {
        const fullPath = path.join(currentDir, item);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (this.matchesPattern(item, pattern)) {
          results.push(fullPath);
        }
      }
    };
    walk(dir);
    return results;
  }

  private matchesPattern(filename: string, pattern: string): boolean {
    // Simple pattern matching (can be enhanced)
    if (pattern.includes('*')) {
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      return regex.test(filename);
    }
    return filename === pattern;
  }

  private buildComprehensivePrompt(): string {
    const {
      targetFile,
      startLine,
      endLine,
      reviewComment,
      previousAttempts = [],
      suggestedFixes = [],
      committableSuggestions = []
    } = this.options;

    let prompt = `# Interactive Code Editing Session

You are an expert code editor working in a CLI environment. You have full read/write access to the codebase and can make multiple edits iteratively.

## Task Context
- **File to edit**: \`${targetFile}\`
- **Target lines**: ${startLine}-${endLine}
- **Review comment**: ${reviewComment}

## Previous Attempts (for learning)
`;

    if (previousAttempts.length > 0) {
      previousAttempts.forEach((attempt, i) => {
        prompt += `
### Attempt ${i + 1} (${attempt.llm})
**Patch**:
\`\`\`diff
${attempt.patch}
\`\`\`

**Error**: ${attempt.error}
`;
      });
    } else {
      prompt += `
No previous attempts - this is the first try.
`;
    }

    prompt += `

## Suggested Solutions (use as inspiration)
`;

    if (suggestedFixes.length > 0) {
      suggestedFixes.forEach((fix, i) => {
        prompt += `
### Suggested Fix ${i + 1}:
\`\`\`
${fix}
\`\`\`
`;
      });
    }

    if (committableSuggestions.length > 0) {
      committableSuggestions.forEach((suggestion, i) => {
        prompt += `
### Committable Suggestion ${i + 1}:
\`\`\`
${suggestion}
\`\`\`
`;
      });
    }

    prompt += `

## Your Instructions

1. **Read the target file first** to understand the current code structure
2. **Analyze the review comment** and understand what needs to be fixed
3. **Learn from previous attempts** - avoid making the same mistakes
4. **Make edits iteratively** - you can read, edit, and validate multiple times
5. **Think step by step** - explain your reasoning before making changes
6. **Validate your changes** - ensure the code still works and addresses the review

## Available Commands
- \`read <file>\` - Read file contents
- \`edit <file>\` - Edit a file (enter interactive mode)
- \`write <file>\` - Write new content to a file
- \`diff <file>\` - Show changes made to a file
- \`validate\` - Run basic validation checks
- \`done\` - Finish the session and output results

## Important Notes
- Focus on making minimal, targeted changes
- Ensure code compiles and follows existing patterns
- If you need to edit multiple files, explain why
- When done, provide a summary of all changes made

Start by reading the target file and analyzing the situation.
`;

    return prompt;
  }

  private async executeQwenCLI(prompt: string): Promise<any> {
    log.step('Executing Qwen in interactive CLI mode');
    
    return new Promise((resolve, reject) => {
      const qwenProcess = spawn('qwen', ['--interactive', '--no-color'], {
        cwd: this.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          QWEN_SESSION_ID: `pr-autopilot-${Date.now()}`,
          QWEN_WORKSPACE: this.workDir
        }
      });

      let output = '';
      let thinking = '';
      this.rounds = 0;

      qwenProcess.stdin.write(prompt);
      qwenProcess.stdin.end();

      qwenProcess.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        
        // Extract thinking content
        const thinkingMatch = text.match(/```thinking\n([\s\S]*?)\n```/);
        if (thinkingMatch) {
          thinking += thinkingMatch[1] + '\n';
          this.thinkingLog.push(thinkingMatch[1]);
        }
        
        log.detail(text.trim());
      });

      qwenProcess.stderr.on('data', (data) => {
        log.error(`Qwen CLI error: ${data.toString()}`);
      });

      qwenProcess.on('close', (code) => {
        if (code === 0) {
          this.rounds++;
          log.success(`Qwen CLI completed in round ${this.rounds}`);
          resolve({ output, thinking });
        } else {
          reject(new Error(`Qwen CLI exited with code ${code}`));
        }
      });

      qwenProcess.on('error', (error) => {
        reject(new Error(`Failed to start Qwen CLI: ${error.message}`));
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        qwenProcess.kill();
        reject(new Error('Qwen CLI session timed out'));
      }, 5 * 60 * 1000);
    });
  }

  private async validateAndCollectResults(result: any): Promise<EnhancedQwenResult> {
    log.step('Validating and collecting results');
    
    const editedFiles: Array<{ file: string; content: string }> = [];
    const appliedFiles: string[] = [];
    const failedFiles: Array<{ file: string; error: string }> = [];
    const warnings: string[] = [];

    // Find all modified files
    const repoDir = this.options.gitOps.getRepoDir(this.options.repo);
    const workspaceFiles = await this.getAllFiles(this.workDir);
    
    for (const workspaceFile of workspaceFiles) {
      const relativePath = path.relative(this.workDir, workspaceFile);
      const originalFile = path.join(repoDir, relativePath);
      
      if (fs.existsSync(originalFile)) {
        const originalContent = fs.readFileSync(originalFile, 'utf8');
        const editedContent = fs.readFileSync(workspaceFile, 'utf8');
        
        if (originalContent !== editedContent) {
          editedFiles.push({
            file: relativePath,
            content: editedContent
          });
          
          // Generate patch for this file
          try {
            const patch = await this.generatePatch(relativePath, originalContent, editedContent);
            if (patch) {
              appliedFiles.push(relativePath);
            }
          } catch (error: any) {
            failedFiles.push({
              file: relativePath,
              error: error.message
            });
          }
        }
      }
    }

    // Generate combined patch
    let combinedPatch = '';
    if (editedFiles.length > 0) {
      combinedPatch = editedFiles.map(file => {
        const relativePath = file.file;
        const content = file.content;
        return `--- a/${relativePath}\n+++ b/${relativePath}\n@@ -1,1 +1,1 @@\n-${this.getFileMarker(relativePath, 'old')}\n+${content}`;
      }).join('\n\n');
    }

    return {
      success: appliedFiles.length > 0 && failedFiles.length === 0,
      patch: combinedPatch,
      editedFiles,
      thinking: this.thinkingLog.join('\n'),
      rounds: this.rounds,
      validationDetails: {
        appliedFiles,
        failedFiles,
        warnings
      }
    };
  }

  private async getAllFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    const items = fs.readdirSync(dir);
    
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        files.push(...await this.getAllFiles(fullPath));
      } else {
        files.push(fullPath);
      }
    }
    
    return files;
  }

  private getFileMarker(filePath: string, type: 'old' | 'new'): string {
    // Simple marker - in real implementation would read actual file content
    return `[${type.toUpperCase()} FILE CONTENT: ${filePath}]`;
  }

  private async generatePatch(filePath: string, oldContent: string, newContent: string): Promise<string> {
    // Generate unified diff
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    
    // Simple diff implementation - can be enhanced with proper diff algorithm
    let patch = `--- a/${filePath}\n+++ b/${filePath}\n`;
    
    if (oldContent === newContent) {
      return '';
    }
    
    // For now, return a simple replacement diff
    patch += `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
    
    if (oldLines.length > 0) {
      oldLines.forEach(line => patch += `-${line}\n`);
    }
    
    if (newLines.length > 0) {
      newLines.forEach(line => patch += `+${line}\n`);
    }
    
    return patch;
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
