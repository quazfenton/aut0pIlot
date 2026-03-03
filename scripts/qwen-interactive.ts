import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawn, ChildProcess } from 'child_process';
import { PatchRequest, PatchResult } from './types';

const log = {
  header:  (msg: string) => console.log(`\n\x1b[1;38;5;201m[QWEN-INTERACTIVE] ══ ${msg} ══\x1b[0m`),
  step:    (msg: string) => console.log(`\x1b[38;5;201m[QWEN]\x1b[0m ${msg}`),
  detail:  (msg: string) => console.log(`\x1b[2m[QWEN-DETAIL]\x1b[0m ${msg}`),
  warn:    (msg: string) => console.log(`\x1b[1;33m[QWEN-WARN]\x1b[0m ${msg}`),
  error:   (msg: string) => console.log(`\x1b[1;31m[QWEN-ERROR]\x1b[0m ${msg}`),
  success: (msg: string) => console.log(`\x1b[1;32m[QWEN-SUCCESS]\x1b[0m ${msg}`),
  iteration: (msg: string) => console.log(`\x1b[38;5;46m[QWEN-ITER]\x1b[0m ${msg}`),
};

interface QwenSessionOptions {
  maxIterations?: number;
  timeoutPerIteration?: number;
  includeFullProjectContext?: boolean;
  allowMultiFileEdits?: boolean;
  workingDir?: string;
  onProgress?: (iteration: number, output: string) => void;
}

interface QwenSessionResult {
  success: boolean;
  patch?: string;
  additionalFiles?: Array<{ file: string; patch: string; reason: string }>;
  iterations: number;
  output: string;
  error?: string;
}

interface FileSnapshot {
  full_content: string;
  lines: string[];
  context: string;
  line_offset: number;
}

/**
 * QwenInteractive - A comprehensive Qwen session handler that mimics
 * a manual interactive session with full project context and iterative refinement.
 */
export class QwenInteractive {
  private tempDir: string;
  private sessionDir: string;

  constructor() {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-session-'));
    this.sessionDir = this.tempDir;
  }

  /**
   * Run a comprehensive Qwen session to fix a review comment.
   * This method:
   * 1. Loads full project context
   * 2. Runs iterative Qwen calls until a valid patch is produced
   * 3. Allows Qwen to make multi-file changes if needed
   * 4. Validates and repairs patches automatically
   */
  async runSession(
    request: PatchRequest,
    fileContent: FileSnapshot,
    options: QwenSessionOptions = {}
  ): Promise<QwenSessionResult> {
    const {
      maxIterations = 10,
      timeoutPerIteration = 300000, // 5 minutes per iteration
      includeFullProjectContext = true,
      allowMultiFileEdits = true,
      workingDir,
      onProgress,
    } = options;

    log.header(`Starting comprehensive Qwen session for ${request.file}`);
    log.step(`Max iterations: ${maxIterations}`);
    log.step(`Full project context: ${includeFullProjectContext}`);
    log.step(`Multi-file edits: ${allowMultiFileEdits}`);

    // Determine working directory (project root)
    const projectDir = workingDir || await this.getProjectDirectory(request);
    if (!projectDir) {
      return {
        success: false,
        iterations: 0,
        output: '',
        error: 'Could not determine project directory',
      };
    }

    log.step(`Working directory: ${projectDir}`);

    // Build comprehensive context
    const projectContext = includeFullProjectContext 
      ? await this.buildFullProjectContext(projectDir, request)
      : '';

    // Build the initial comprehensive prompt
    let currentPrompt = this.buildComprehensivePrompt(
      request,
      fileContent,
      projectContext,
      allowMultiFileEdits
    );

    // Save prompt to file for debugging
    const promptFile = path.join(this.sessionDir, 'initial-prompt.txt');
    fs.writeFileSync(promptFile, currentPrompt);
    log.detail(`Initial prompt saved to: ${promptFile}`);

    // Session state
    let iteration = 0;
    let lastOutput = '';
    let allOutputs: string[] = [];
    let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    // Main iterative loop
    while (iteration < maxIterations) {
      iteration++;
      log.iteration(`=== Iteration ${iteration}/${maxIterations} ===`);

      try {
        // Call Qwen with current prompt
        const output = await this.callQwenWithRetry(
          currentPrompt,
          projectDir,
          timeoutPerIteration,
          iteration
        );

        if (!output) {
          log.warn(`Empty output from Qwen, retrying...`);
          currentPrompt += `\n\n[SYSTEM NOTE: Previous response was empty. Please provide a response.]\n`;
          continue;
        }

        lastOutput = output;
        allOutputs.push(output);
        onProgress?.(iteration, output);

        // Save output for debugging
        const outputFile = path.join(this.sessionDir, `output-iter-${iteration}.txt`);
        fs.writeFileSync(outputFile, output);
        log.detail(`Output saved to: ${outputFile}`);

        // Add to conversation history
        conversationHistory.push({ role: 'assistant', content: output });

        // Try to extract a valid patch
        const extractionResult = this.extractPatchesFromOutput(output, request.file);
        
        if (extractionResult.primaryPatch) {
          log.step(`Found patch in iteration ${iteration}`);

          // Validate the primary patch
          const validationResult = await this.validatePatch(
            extractionResult.primaryPatch,
            request,
            fileContent,
            projectDir
          );

          if (validationResult.valid) {
            log.success(`Valid patch produced in iteration ${iteration}!`);
            
            return {
              success: true,
              patch: extractionResult.primaryPatch,
              additionalFiles: extractionResult.additionalPatches,
              iterations: iteration,
              output: lastOutput,
            };
          } else {
            log.warn(`Patch validation failed: ${validationResult.error}`);
            
            // Try to repair the patch
            const repaired = this.repairPatch(
              extractionResult.primaryPatch,
              fileContent,
              request
            );

            if (repaired) {
              const repairValidation = await this.validatePatch(
                repaired,
                request,
                fileContent,
                projectDir
              );

              if (repairValidation.valid) {
                log.success(`Repaired patch is valid!`);
                return {
                  success: true,
                  patch: repaired,
                  additionalFiles: extractionResult.additionalPatches,
                  iterations: iteration,
                  output: lastOutput,
                };
              }
            }

            // Add validation feedback to next prompt
            currentPrompt = this.buildFeedbackPrompt(
              output,
              validationResult.error || 'Unknown validation error',
              fileContent,
              request
            );
          }
        } else {
          // No patch found - check if Qwen is asking for more info or needs guidance
          const needsMoreContext = this.detectNeedsMoreContext(output);
          
          if (needsMoreContext) {
            log.step(`Qwen needs more context, providing additional file content...`);
            currentPrompt = this.buildContextFollowUpPrompt(
              output,
              fileContent!,  // Add non-null assertion since we know it exists
              request,
              projectDir
            );
          } else {
            // No patch and no clear need for more context - guide Qwen
            currentPrompt = this.buildGuidancePrompt(output, request, fileContent);
          }
        }

        // Add iteration feedback
        currentPrompt += `\n\n[ITERATION ${iteration}/${maxIterations}] `;
        if (iteration < maxIterations) {
          currentPrompt += `Please continue refining. `;
        } else {
          currentPrompt += `This is the final iteration. Please provide your best solution.`;
        }

      } catch (error: any) {
        log.error(`Iteration ${iteration} error: ${error.message}`);
        
        if (error.message?.includes('timeout')) {
          currentPrompt += `\n\n[SYSTEM: Previous iteration timed out. Please provide a more concise response.]\n`;
        } else {
          currentPrompt += `\n\n[SYSTEM: Previous iteration failed with error: ${error.message}. Please try again.]\n`;
        }
      }
    }

    // Max iterations reached without valid patch
    log.warn(`Max iterations (${maxIterations}) reached without valid patch`);
    
    // Try one last extraction from all outputs
    const allOutputText = allOutputs.join('\n\n--- ITERATION ---\n\n');
    const lastExtraction = this.extractPatchesFromOutput(allOutputText, request.file);

    return {
      success: false,
      patch: lastExtraction.primaryPatch || undefined,
      additionalFiles: lastExtraction.additionalPatches,
      iterations: iteration,
      output: allOutputText,
      error: 'Max iterations reached without producing a valid patch',
    };
  }

  /**
   * Build a comprehensive initial prompt with full context
   */
  private buildComprehensivePrompt(
    request: PatchRequest,
    fileContent: FileSnapshot,
    projectContext: string,
    allowMultiFileEdits: boolean
  ): string {
    const { file, start_line, end_line, content, diff_hunk } = request;

    // Extract the relevant code section
    const targetStart = Math.max(1, start_line - 10);
    const targetEnd = Math.min(fileContent.lines.length, end_line + 10);
    const codeSection = fileContent.lines.slice(targetStart - 1, targetEnd).join('\n');

    let prompt = `You are an expert code reviewer helping to fix a GitHub Pull Request review comment.

## PROJECT CONTEXT
${projectContext}

## FILE BEING MODIFIED
File: ${file}
Lines: ${start_line}-${end_line}

## CURRENT CODE (lines ${targetStart}-${targetEnd})
\`\`\`
${codeSection}
\`\`\`

## DIFF HUNK (from review)
\`\`\`diff
${diff_hunk || 'Not provided'}
\`\`\`

## REVIEW COMMENT TO ADDRESS
${content}

## YOUR TASK
Analyze the review comment and the code, then generate a fix. You may:
1. Make a single-file fix if that's sufficient
${allowMultiFileEdits ? `2. Make multi-file changes if the fix requires updates to related files` : ''}

## OUTPUT FORMAT
Provide your solution as a unified diff patch in this EXACT format:

\`\`\`diff
--- a/${file}
+++ b/${file}
@@ -${start_line},${end_line - start_line + 1} +${start_line},<new_count> @@
 context line
-original line
+new line
 context line
\`\`\`

${allowMultiFileEdits ? `
If you need to modify additional files, provide a separate diff block for each file:

\`\`\`diff
--- a/path/to/other/file.ext
+++ b/path/to/other/file.ext
@@ -X,Y +X,Z @@
...
\`\`\`
` : ''}

IMPORTANT:
1. The diff MUST start with --- a/ and +++ b/ headers
2. The @@ line must have correct line numbers
3. Preserve exact indentation (spaces/tabs)
4. Include 3 lines of context before and after changes
5. Do NOT include explanations inside the diff block

After the diff, you may explain your changes briefly.

Begin your response now.
`;

    return prompt;
  }

  /**
   * Build a feedback prompt when patch validation fails
   */
  private buildFeedbackPrompt(
    previousOutput: string,
    validationError: string,
    fileContent: FileSnapshot,
    request: PatchRequest
  ): string {
    const { file, start_line, end_line } = request;

    return `Your previous patch did not apply cleanly. Here's what went wrong:

ERROR: ${validationError}

The original file content at lines ${start_line}-${end_line} is:
\`\`\`
${fileContent.lines.slice(start_line - 1, end_line).join('\n')}
\`\`\`

Please generate a corrected unified diff patch that:
1. Has exact line numbers matching the file
2. Preserves exact indentation (including leading spaces)
3. Includes context lines that match the file EXACTLY

Your previous attempt was:
${previousOutput.substring(0, 2000)}

Please try again with a corrected patch.
`;
  }

  /**
   * Build a prompt for providing more context
   */
  private buildContextFollowUpPrompt(
    previousOutput: string,
    fileContent: FileSnapshot,
    request: PatchRequest,
    projectDir: string
  ): string {
    // Try to identify what files Qwen is asking about
    const fileMentions = this.extractFileMentions(previousOutput);
    
    let additionalContext = '';
    
    for (const mentionedFile of fileMentions.slice(0, 3)) {
      const fullPath = path.join(projectDir, mentionedFile);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n').slice(0, 50).join('\n');
          additionalContext += `\n### ${mentionedFile}\n\`\`\`\n${lines}\n\`\`\`\n`;
        } catch (e) {
          // Skip files we can't read
        }
      }
    }

    return `You asked for more context. Here's additional relevant file content:

${additionalContext || 'No additional files found matching your query.'}

Now please provide your fix as a unified diff patch.
`;
  }

  /**
   * Build a guidance prompt when Qwen seems stuck
   */
  private buildGuidancePrompt(
    previousOutput: string,
    request: PatchRequest,
    fileContent: FileSnapshot
  ): string {
    const { file, start_line, end_line, content } = request;

    return `I need you to focus on generating a unified diff patch.

Your previous response didn't contain a valid diff format. 

The review comment asks: "${content.substring(0, 200)}"

Please generate a unified diff patch for ${file} lines ${start_line}-${end_line}.

Remember the format:
\`\`\`diff
--- a/${file}
+++ b/${file}
@@ -${start_line},X +${start_line},Y @@
 context
-old line
+new line
 context
\`\`\`

Generate the patch now.
`;
  }

  /**
   * Call Qwen with retry logic
   */
  private async callQwenWithRetry(
    prompt: string,
    workingDir: string,
    timeout: number,
    iteration: number
  ): Promise<string> {
    const promptFile = path.join(this.sessionDir, `prompt-iter-${iteration}.txt`);
    fs.writeFileSync(promptFile, prompt);

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        log.step(`Calling Qwen (iteration ${iteration}, attempt ${attempt + 1}/${maxRetries})...`);
        
        const output = execSync(
          `qwen "$(cat ${promptFile})"`,
          {
            cwd: workingDir,
            stdio: 'pipe',
            timeout,
            maxBuffer: 16 * 1024 * 1024, // 16MB buffer
            env: { 
              ...process.env, 
              NO_COLOR: '1',
              QWEN_NO_INTERACTIVE: '1',
            },
          }
        ).toString().trim();

        log.detail(`Qwen returned ${output.length} chars`);
        return output;

      } catch (error: any) {
        lastError = error;
        log.warn(`Qwen call failed (attempt ${attempt + 1}): ${error.message?.substring(0, 200)}`);
        
        // Wait before retry
        if (attempt < maxRetries - 1) {
          await this.sleep(2000 * (attempt + 1));
        }
      }
    }

    throw lastError || new Error('Qwen call failed');
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
   * Validate a patch by testing git apply
   */
  private async validatePatch(
    patch: string,
    request: PatchRequest,
    fileContent: FileSnapshot,
    projectDir: string
  ): Promise<{ valid: boolean; error?: string }> {
    // Basic format checks
    if (!patch.includes('--- a/') || !patch.includes('+++ b/')) {
      return { valid: false, error: 'Patch missing --- a/ or +++ b/ headers' };
    }

    if (!patch.includes('@@')) {
      return { valid: false, error: 'Patch missing @@ hunk marker' };
    }

    // Check for balanced +/- lines
    const minusLines = (patch.match(/^\-/gm) || []).length;
    const plusLines = (patch.match(/^\+/gm) || []).length;
    
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
   * Attempt to repair a patch
   */
  private repairPatch(
    patch: string,
    fileContent: FileSnapshot,
    request: PatchRequest
  ): string | null {
    const { file, start_line } = request;

    // Common issues to fix:
    // 1. Missing newline at end
    let repaired = patch.trimEnd() + '\n';

    // 2. Wrong line numbers - try to recalculate
    const hunkMatch = repaired.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
    if (hunkMatch) {
      const oldStart = parseInt(hunkMatch[1], 10);
      if (oldStart !== start_line && oldStart !== start_line - 3) {
        // Try to correct line numbers
        const correctStart = Math.max(1, start_line - 3);
        repaired = repaired.replace(
          /@@ -\d+,(\d+) \+\d+,(\d+) @@/,
          `@@ -${correctStart},$1 +${correctStart},$2 @@`
        );
        log.detail(`Adjusted line numbers from ${oldStart} to ${correctStart}`);
      }
    }

    // 3. Missing context - add minimal context from file
    const lines = repaired.split('\n');
    const hasContextBefore = lines.some((l, i) => i > 2 && l.startsWith(' ') && !l.startsWith('---') && !l.startsWith('+++'));
    
    if (!hasContextBefore && fileContent.lines.length > 0) {
      // Try to add context from the file
      const contextLine = fileContent.lines[start_line - 2]; // line before
      if (contextLine) {
        // Insert context line at the right position
        const hunkLineIndex = lines.findIndex(l => l.startsWith('@@'));
        if (hunkLineIndex >= 0) {
          lines.splice(hunkLineIndex + 1, 0, ' ' + contextLine);
          repaired = lines.join('\n');
        }
      }
    }

    return repaired;
  }

  /**
   * Detect if Qwen is asking for more context
   */
  private detectNeedsMoreContext(output: string): boolean {
    const indicators = [
      /I need to see/i,
      /can you show me/i,
      /what does .* look like/i,
      /I need more context/i,
      /please provide.*file/i,
      /show me the.*file/i,
      /could you share/i,
    ];

    return indicators.some(regex => regex.test(output));
  }

  /**
   * Extract file mentions from Qwen output
   */
  private extractFileMentions(output: string): string[] {
    const files: string[] = [];
    
    // Look for file paths mentioned
    const filePatterns = [
      /(?:file|in|see|look at|check)\s+[`']?([a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,10})[`']?/gi,
      /([a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,10}):\d+/gi, // file:line format
    ];

    for (const pattern of filePatterns) {
      let match;
      while ((match = pattern.exec(output)) !== null) {
        const file = match[1];
        if (!files.includes(file) && !file.startsWith('---') && !file.startsWith('+++')) {
          files.push(file);
        }
      }
    }

    return files;
  }

  /**
   * Get project directory from request
   */
  private async getProjectDirectory(request: PatchRequest): Promise<string | null> {
    // Try to find an existing clone
    const possibleDirs = [
      `/tmp/pr-autopilot-${request.repo.split('/')[1]}`,
      `/tmp/${request.repo.split('/')[1]}`,
      path.join(os.tmpdir(), 'pr-autopilot', request.repo.split('/')[1]),
    ];

    for (const dir of possibleDirs) {
      if (fs.existsSync(dir) && fs.existsSync(path.join(dir, '.git'))) {
        return dir;
      }
    }

    // If no clone found, the caller should provide the working directory
    return null;
  }

  /**
   * Build full project context string
   */
  private async buildFullProjectContext(projectDir: string, request: PatchRequest): Promise<string> {
    const parts: string[] = [];

    // 1. Project structure
    try {
      const structure = execSync(
        'find . -maxdepth 3 -type f -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.go" 2>/dev/null | head -50',
        { cwd: projectDir, encoding: 'utf-8', timeout: 5000 }
      );
      parts.push(`### Project Structure\n\`\`\`\n${structure}\n\`\`\``);
    } catch (e) {
      // Ignore
    }

    // 2. package.json or equivalent config
    const configFiles = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'];
    for (const configFile of configFiles) {
      const configPath = path.join(projectDir, configFile);
      if (fs.existsSync(configPath)) {
        try {
          const content = fs.readFileSync(configPath, 'utf-8');
          parts.push(`### ${configFile}\n\`\`\`\n${content.substring(0, 500)}\n\`\`\``);
          break;
        } catch (e) {
          // Ignore
        }
      }
    }

    // 3. README if exists
    const readmePath = path.join(projectDir, 'README.md');
    if (fs.existsSync(readmePath)) {
      try {
        const content = fs.readFileSync(readmePath, 'utf-8');
        parts.push(`### README\n${content.substring(0, 1000)}`);
      } catch (e) {
        // Ignore
      }
    }

    // 4. Related files based on the target file
    const targetBase = path.basename(request.file, path.extname(request.file));
    try {
      const relatedFiles = execSync(
        `find . -type f -name "*${targetBase}*" 2>/dev/null | head -10`,
        { cwd: projectDir, encoding: 'utf-8', timeout: 5000 }
      );
      if (relatedFiles.trim()) {
        parts.push(`### Related Files\n${relatedFiles}`);
      }
    } catch (e) {
      // Ignore
    }

    return parts.join('\n\n');
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
