import { PatchRequest, PatchResult, ExtractedSuggestion } from './types';
import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const log = {
  header: (msg: string) => console.log(`\x1b[1;38;5;208m[QWEN-INTERACTIVE] ══ ${msg} ══\x1b[0m`),
  step: (msg: string) => console.log(`\x1b[32m[QWEN]\x1b[0m ${msg}`),
  detail: (msg: string) => console.log(`\x1b[2m[QWEN-DETAIL]\x1b[0m ${msg}`),
  warn: (msg: string) => console.log(`\x1b[1;33m[QWEN-WARN]\x1b[0m ${msg}`),
  error: (msg: string) => console.log(`\x1b[1;31m[QWEN-ERROR]\x1b[0m ${msg}`),
  success: (msg: string) => console.log(`\x1b[1;32m[QWEN-SUCCESS]\x1b[0m ${msg}`),
  thinking: (msg: string) => console.log(`\x1b[38;5;213m[QWEN-THINKING]\x1b[0m ${msg}`),
  diff: (msg: string) => console.log(`\x1b[38;5;245m[QWEN-DIFF]\x1b[0m ${msg}`),
};

interface FileSnapshot {
  full_content: string;
  lines: string[];
  context: string;
  line_offset: number;
}

export interface QwenInteractiveOptions {
  maxIterations: number;
  timeout: number;
  projectDir: string;
}

export class QwenInteractive {
  private tempDir: string;
  private sessionDir: string;
  private thinkingLog: string[] = [];

  constructor(private options: QwenInteractiveOptions) {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-interactive-'));
    this.sessionDir = path.join(this.tempDir, 'session');
    fs.mkdirSync(this.sessionDir, { recursive: true });
  }

  /**
   * Main entry point for interactive Qwen session
   */
  async generatePatch(request: PatchRequest): Promise<PatchResult> {
    log.header(`Starting interactive Qwen session for ${request.file}`);

    try {
      // Setup project context
      const projectDir = await this.setupProjectContext(request);
      
      // Build prompt
      const prompt = this.buildPrompt(request, projectDir);
      
      // Call Qwen iteratively
      for (let iteration = 1; iteration <= this.options.maxIterations; iteration++) {
        log.step(`\n========== ITERATION ${iteration}/${this.options.maxIterations} ==========`);
        
        try {
          // SECURITY FIX: Use spawn with stdin instead of shell command
          // This prevents command injection via malicious prompt content
          const output = await this.callQwenWithStdin(prompt, projectDir, this.options.timeout, iteration);
          
          // Extract patch
          const patches = this.extractPatchesFromOutput(output, request.file);
          
          if (patches.primaryPatch) {
            // Validate patch
            const validation = this.validatePatch(patches.primaryPatch, projectDir);
            
            if (validation.valid) {
              log.success(`Iteration ${iteration} produced valid patch!`);
              return {
                success: true,
                patch: patches.primaryPatch,
                requires_approval: false
              };
            } else {
              log.warn(`Patch validation failed: ${validation.error}`);
              // Add error to prompt for next iteration
              prompt += `\n\nPrevious patch failed validation: ${validation.error}`;
            }
          } else {
            log.warn(`No patch extracted from Qwen output`);
          }
          
        } catch (error: any) {
          log.error(`Iteration ${iteration} failed: ${error.message}`);
        }
      }
      
      return {
        success: false,
        error: `Failed to produce valid patch after ${this.options.maxIterations} iterations`,
        requires_approval: false
      };
      
    } finally {
      this.cleanup();
    }
  }

  /**
   * Call Qwen with prompt piped to stdin (secure, no shell injection)
   */
  private async callQwenWithStdin(promptFile: string, workingDir: string, timeout: number, iteration: number): Promise<string> {
    return new Promise((resolve, reject) => {
      // Read prompt file content
      let promptContent: string;
      try {
        promptContent = fs.readFileSync(promptFile, 'utf-8');
      } catch (error: any) {
        reject(new Error(`Failed to read prompt file: ${error.message}`));
        return;
      }

      // Spawn qwen process with arguments (no shell)
      const qwen = spawn('qwen', [], {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NO_COLOR: '1',
          QWEN_NO_INTERACTIVE: '1',
        }
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Set timeout
      const timeoutId = setTimeout(() => {
        timedOut = true;
        qwen.kill();
        reject(new Error('Qwen process timed out'));
      }, timeout);

      // Write prompt to stdin
      qwen.stdin.write(promptContent);
      qwen.stdin.end();

      // Collect stdout
      qwen.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      // Collect stderr
      qwen.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // Handle process exit
      qwen.on('close', (code: number | null) => {
        clearTimeout(timeoutId);
        if (timedOut) return;

        if (code === 0 || stdout.length > 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Qwen exited with code ${code}: ${stderr.substring(0, 500)}`));
        }
      });

      // Handle errors
      qwen.on('error', (error: Error) => {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to start Qwen: ${error.message}`));
      });
    });
  }

  /**
   * Extract patches from Qwen output
   */
  private extractPatchesFromOutput(
    output: string,
    primaryFile: string
  ): { primaryPatch: string | null; additionalPatches: Array<{ file: string; patch: string; reason: string }> } {
    const patches: Array<{ file: string; patch: string }> = [];

    // Pattern 1: ```diff ... ```
    const diffBlockRegex = /```diff\n([\s\S]*?)```/g;
    let match;
    while ((match = diffBlockRegex.exec(output)) !== null) {
      const patch = match[1].trim();
      const fileMatch = patch.match(/^\+\+\+ b\/(.+)$/m);
      const file = fileMatch ? fileMatch[1] : primaryFile;
      patches.push({ file, patch });
    }

    // Pattern 2: --- a/... +++ b/... @@ ... (raw diff without code block)
    const rawDiffRegex = /^(--- a\/.*\n\+\+\+ b\/.*\n@@ .* @@[\s\S]*?)(?=^--- a\/|\n```|\n## |$)/gm;
    while ((match = rawDiffRegex.exec(output)) !== null) {
      const patch = match[1].trim();
      const fileMatch = patch.match(/^\+\+\+ b\/(.+)$/m);
      const file = fileMatch ? fileMatch[1] : primaryFile;

      // Avoid duplicates
      if (!patches.some(p => p.patch === patch)) {
        patches.push({ file, patch });
      }
    }

    // Pattern 3: Look for @@ hunk markers and build patch
    if (patches.length === 0) {
      const hunkRegex = /@@ -(\d+),?\d* \+(\d+),?\d* @@[\s\S]*?(?=@@|$)/g;
      while ((match = hunkRegex.exec(output)) !== null) {
        const hunk = match[0];
        // Check if this looks like actual diff content
        if (hunk.includes('\n-') || hunk.includes('\n+')) {
          const patch = `--- a/${primaryFile}\n+++ b/${primaryFile}\n${hunk}`;
          patches.push({ file: primaryFile, patch });
        }
      }
    }

    // Separate primary and additional patches
    const primaryPatch = patches.find(p => p.file === primaryFile)?.patch || patches[0]?.patch || null;
    const additionalPatches = patches
      .filter(p => p.file !== primaryFile)
      .map(p => ({ file: p.file, patch: p.patch, reason: 'Related file change' }));

    if (primaryPatch) {
      log.detail(`Extracted primary patch (${primaryPatch.length} chars) for ${primaryFile}`);
    }
    if (additionalPatches.length > 0) {
      log.detail(`Found ${additionalPatches.length} additional file patches`);
    }

    return { primaryPatch, additionalPatches };
  }

  /**
   * Validate patch
   */
  private validatePatch(patch: string, projectDir: string): { valid: boolean; error?: string } {
    // Check for required headers
    if (!patch.includes('--- a/') || !patch.includes('+++ b/')) {
      return { valid: false, error: 'Patch missing --- a/ or +++ b/ headers' };
    }

    if (!patch.includes('@@')) {
      return { valid: false, error: 'Patch missing @@ hunk marker' };
    }

    // SECURITY FIX: Use specific regexes that exclude headers
    // Old regex /^\-/gm matched '--- a/' headers, making this check always pass
    const minusLines = (patch.match(/^(?!\+\+\+|---)-.*$/gm) || []).length;
    const plusLines = (patch.match(/^(?!\+\+\+)\+.*$/gm) || []).length;

    if (minusLines === 0 && plusLines === 0) {
      return { valid: false, error: 'Patch has no actual changes' };
    }

    // Try git apply --check if we have a git repo
    const testFile = path.join(this.sessionDir, 'test.patch');
    fs.writeFileSync(testFile, patch);

    try {
      execSync(`git apply --check "${testFile}"`, {
        cwd: projectDir,
        stdio: 'pipe',
        timeout: 10000,
      });
      return { valid: true };
    } catch (error: any) {
      const stderr = error.stderr?.toString() || '';
      return { valid: false, error: stderr.substring(0, 500) };
    }
  }

  /**
   * Setup project context
   */
  private async setupProjectContext(request: PatchRequest): Promise<string> {
    const projectDir = this.options.projectDir;
    
    // Copy target file to session dir for reference
    if (request.file) {
      const targetPath = path.join(projectDir, request.file);
      if (fs.existsSync(targetPath)) {
        const sessionTargetPath = path.join(this.sessionDir, path.basename(request.file));
        fs.mkdirSync(path.dirname(sessionTargetPath), { recursive: true });
        fs.copyFileSync(targetPath, sessionTargetPath);
      }
    }
    
    return projectDir;
  }

  /**
   * Build prompt for Qwen
   */
  private buildPrompt(request: PatchRequest, projectDir: string): string {
    const parts: string[] = [];

    parts.push(`# Code Fix Request

## Target File
\`${request.file}\` (lines ${request.start_line}-${request.end_line})

## Review Comment
${request.content}

${request.suggestions && request.suggestions.length > 0 ? `
## Suggested Fixes
${request.suggestions.map(s => `
\`\`\`
${s.code}
\`\`\`
`).join('\n')}
` : ''}

## Instructions
1. Read the target file to understand the context
2. Understand what needs to be fixed based on the review comment
3. Generate a unified diff patch that fixes the issue
4. Ensure the patch applies cleanly

Output your fix as a unified diff patch:`);

    return parts.join('\n');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clean up session resources
   */
  cleanup(): void {
    try {
      if (fs.existsSync(this.tempDir)) {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      }
    } catch (error) {
      console.error('[QWEN] Error cleaning up session:', error);
    }
  }
}
