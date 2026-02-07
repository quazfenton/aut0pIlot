#!/usr/bin/env node

/**
 * Specialized Qwen runner for PR Autopilot with repository context
 * This script clones the target repository and runs Qwen in that context for better code understanding
 */

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const TEMP_DIR = '/tmp/pr-autopilot-context';
const REPO_BASE_URL = 'https://github.com';

class QwenSpecializedRunner {
  private tempDir: string;
  private repoDir: string;
  private repoOwner: string;
  private repoName: string;
  private commitSha: string;

  constructor(repo: string, commitSha: string) {
    this.tempDir = TEMP_DIR;
    const [owner, name] = repo.split('/');
    this.repoOwner = owner;
    this.repoName = name;
    this.commitSha = commitSha;
    this.repoDir = path.join(this.tempDir, `${owner}-${name}`);
  }

  /**
   * Clone the repository at the specific commit
   */
  async cloneRepository(): Promise<void> {
    console.log(`Cloning ${this.repoOwner}/${this.repoName} at commit ${this.commitSha}...`);

    // Create temp directory if it doesn't exist
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    // Remove existing repo directory if it exists
    if (fs.existsSync(this.repoDir)) {
      fs.rmSync(this.repoDir, { recursive: true, force: true });
    }

    // Clone the repository
    const repoUrl = `${REPO_BASE_URL}/${this.repoOwner}/${this.repoName}.git`;
    const cloneArgs = ['clone', '--depth=1', repoUrl, this.repoDir];
    
    await this.runCommand('git', cloneArgs);

    // Checkout the specific commit if it's not the HEAD
    if (this.commitSha && this.commitSha !== 'HEAD' && this.commitSha !== 'main' && this.commitSha !== 'master') {
      await this.runCommand('git', ['fetch', '--depth=1', 'origin', this.commitSha], { cwd: this.repoDir });
      await this.runCommand('git', ['checkout', this.commitSha], { cwd: this.repoDir });
    }

    console.log(`Repository cloned successfully at ${this.repoDir}`);
  }

  /**
   * Run a command in the repository directory
   */
  private runCommand(command: string, args: string[], options: { cwd?: string } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const cwd = options.cwd || this.repoDir;
      const child = spawn(command, args, { cwd, stdio: 'pipe' });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Command failed: ${command} ${args.join(' ')}\n${stderr}`));
        }
      });

      child.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Get file content from the cloned repository
   */
  getFileContent(filePath: string): string | null {
    const fullPath = path.join(this.repoDir, filePath);
    if (fs.existsSync(fullPath)) {
      return fs.readFileSync(fullPath, 'utf-8');
    }
    return null;
  }

  /**
   * Get a subset of relevant files around the target file for context
   */
  getContextFiles(targetFile: string, contextRadius: number = 2): Record<string, string> {
    const context: Record<string, string> = {};
    const targetDir = path.dirname(targetFile);
    const targetExt = path.extname(targetFile);
    
    // Get files in the same directory
    if (fs.existsSync(path.join(this.repoDir, targetDir))) {
      const dirFiles = fs.readdirSync(path.join(this.repoDir, targetDir))
        .filter(f => path.extname(f) === targetExt) // Same extension
        .filter(f => Math.abs(path.basename(targetFile, targetExt).localeCompare(path.basename(f, targetExt))) <= contextRadius);
      
      for (const file of dirFiles) {
        const filePath = path.join(targetDir, file);
        const content = this.getFileContent(filePath);
        if (content) {
          context[filePath] = content.substring(0, 10000); // Limit content size
        }
      }
    }
    
    return context;
  }

  /**
   * Run Qwen with enhanced context from the repository
   */
  async runQwenWithEnhancedContext(
    targetFile: string, 
    startLine: number, 
    endLine: number, 
    comment: string,
    suggestions?: string[]
  ): Promise<string> {
    // Get the target file content
    const fileContent = this.getFileContent(targetFile);
    if (!fileContent) {
      throw new Error(`Target file does not exist: ${targetFile}`);
    }

    // Extract the specific lines that need to be modified
    const lines = fileContent.split('\n');
    const contextStart = Math.max(0, startLine - 6); // 5 lines before
    const contextEnd = Math.min(lines.length, endLine + 5); // 5 lines after
    const relevantContext = lines.slice(contextStart, contextEnd).join('\n');
    
    // Get additional context files
    const contextFiles = this.getContextFiles(targetFile);
    
    // Build a specialized prompt for Qwen with repository context
    let prompt = this.buildSpecializedPrompt(
      targetFile,
      startLine,
      endLine,
      comment,
      relevantContext,
      contextFiles,
      suggestions
    );

    // Run Qwen in the repository directory for better context
    return this.executeQwen(prompt);
  }

  /**
   * Build a specialized prompt for Qwen with repository context
   */
  private buildSpecializedPrompt(
    targetFile: string,
    startLine: number,
    endLine: number,
    comment: string,
    fileContext: string,
    contextFiles: Record<string, string>,
    suggestions?: string[]
  ): string {
    let prompt = `You are an expert code assistant working on the repository ${this.repoOwner}/${this.repoName}.\n\n`;
    
    prompt += `CONTEXT INFORMATION:\n`;
    prompt += `- Repository: ${this.repoOwner}/${this.repoName}\n`;
    prompt += `- Target file: ${targetFile}\n`;
    prompt += `- Lines to modify: ${startLine}-${endLine}\n`;
    prompt += `- Current commit: ${this.commitSha}\n\n`;
    
    if (suggestions && suggestions.length > 0) {
      prompt += `EXISTING SUGGESTIONS FROM CODE REVIEW:\n`;
      suggestions.forEach((suggestion, idx) => {
        prompt += `${idx + 1}. ${suggestion}\n`;
      });
      prompt += `\n`;
    }
    
    prompt += `CURRENT CODE CONTEXT (lines ${contextStart + 1}-${contextStart + fileContext.split('\n').length} in ${targetFile}):\n`;
    prompt += '```\n';
    prompt += fileContext;
    prompt += '\n```\n\n';
    
    if (Object.keys(contextFiles).length > 0) {
      prompt += `RELATED FILES FOR ADDITIONAL CONTEXT:\n`;
      for (const [filePath, content] of Object.entries(contextFiles)) {
        if (filePath !== targetFile) { // Don't duplicate the target file
          prompt += `\n--- ${filePath} ---\n`;
          prompt += '```\n';
          prompt += content.substring(0, 2000); // Limit context
          prompt += '\n```\n';
        }
      }
      prompt += `\n`;
    }
    
    prompt += `CODE REVIEW COMMENT:\n`;
    prompt += `${comment}\n\n`;
    
    prompt += `INSTRUCTIONS:\n`;
    prompt += `1. Analyze the code in the context of the entire repository\n`;
    prompt += `2. Consider the relationships between files shown above\n`;
    prompt += `3. Generate a fix that addresses the review comment\n`;
    prompt += `4. Return ONLY the fixed code block that replaces lines ${startLine} to ${endLine}\n`;
    prompt += `5. Maintain the exact same indentation and code style\n`;
    prompt += `6. If the fix requires changes outside the specified range, include those lines too\n`;
    prompt += `7. Do NOT include explanations, only the fixed code\n`;
    prompt += `8. Wrap the fixed code in a code block like this:\n`;
    prompt += '```\n';
    prompt += `// your fixed code here\n`;
    prompt += '```\n\n';
    
    prompt += `FIX THE CODE ACCORDING TO THE REVIEW COMMENT:`;

    return prompt;
  }

  /**
   * Execute Qwen CLI with the prompt
   */
  private async executeQwen(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Run Qwen in the repository directory to provide better context
      const child = spawn('qwen', ['-p', prompt, '--max-session-turns', '1', '-o', 'text'], {
        cwd: this.repoDir,  // Run in the cloned repo directory
        stdio: 'pipe',
        env: { ...process.env, NO_COLOR: '1' },
      });

      let output = '';
      let errorOutput = '';

      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0 || output.trim()) {
          resolve(output.trim());
        } else {
          reject(new Error(`Qwen execution failed with code ${code}: ${errorOutput}`));
        }
      });

      child.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Clean up the temporary directory
   */
  cleanup(): void {
    if (fs.existsSync(this.repoDir)) {
      fs.rmSync(this.repoDir, { recursive: true, force: true });
      console.log(`Cleaned up temporary directory: ${this.repoDir}`);
    }
  }
}

// Main execution
async function main() {
  if (process.argv.length < 5) {
    console.error('Usage: node qwen-specialized-runner.js <repo> <commit_sha> <target_file> <start_line> [end_line] [comment] [suggestions_json]');
    console.error('Example: node qwen-specialized-runner.js microsoft/vscode abc123 src/file.ts 10 15 "Fix the bug here" \'["suggestion1", "suggestion2"]\'');
    process.exit(1);
  }

  const [, , repo, commitSha, targetFile, startLineStr, endLineStr, ...rest] = process.argv;
  const startLine = parseInt(startLineStr);
  const endLine = parseInt(endLineStr) || startLine;
  
  // Extract comment and suggestions from remaining args
  let comment = '';
  let suggestions: string[] = [];
  
  if (rest.length > 0) {
    comment = rest[0] || '';
  }
  
  if (rest.length > 1) {
    try {
      suggestions = JSON.parse(rest[1]) || [];
    } catch (e) {
      console.warn('Could not parse suggestions as JSON, using empty array');
      suggestions = [];
    }
  }

  const runner = new QwenSpecializedRunner(repo, commitSha);

  try {
    // Clone the repository
    await runner.cloneRepository();

    // Run Qwen with enhanced context
    const result = await runner.runQwenWithEnhancedContext(
      targetFile,
      startLine,
      endLine,
      comment,
      suggestions
    );

    console.log('Qwen Result:');
    console.log(result);

    // Clean up
    runner.cleanup();
  } catch (error) {
    console.error('Error running specialized Qwen:', error);
    runner.cleanup();
    process.exit(1);
  }
}

// Export the class for use as a module
export { QwenSpecializedRunner };

// Run if this file is executed directly
if (process.argv[1] === __filename) {
  main().catch(console.error);
}