import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { PatchRequest } from './types';

const log = {
  header: (msg: string) => console.log(`\x1b[1;38;5;208m[QWEN-CODER] ══ ${msg} ══\x1b[0m`),
  step: (msg: string) => console.log(`\x1b[32m[QWEN-CODER]\x1b[0m ${msg}`),
  detail: (msg: string) => console.log(`\x1b[2m[QWEN-DETAIL]\x1b[0m ${msg}`),
  warn: (msg: string) => console.log(`\x1b[1;33m[QWEN-WARN]\x1b[0m ${msg}`),
  error: (msg: string) => console.log(`\x1b[1;31m[QWEN-ERROR]\x1b[0m ${msg}`),
  success: (msg: string) => console.log(`\x1b[1;32m[QWEN-SUCCESS]\x1b[0m ${msg}`),
  thinking: (msg: string) => console.log(`\x1b[38;5;213m[QWEN-THINKING]\x1b[0m ${msg}`),
};

export interface QwenSessionOptions {
  maxRounds: number;
  workDir: string;
  targetFile: string;
  fullFileContent: string;
  startLine: number;
  endLine: number;
  reviewComment: string;
  previousPatch?: string;
  previousError?: string;
  suggestedFixes?: string[];
  committableSuggestions?: string[];
  onThinking?: (thinking: string) => void;
}

export interface QwenSessionResult {
  success: boolean;
  editedContent?: string;
  patch?: string;
  thinking?: string;
  additionalEdits?: Array<{ file: string; reason: string }>;
  rounds: number;
  error?: string;
}

export class QwenCoderSession {
  private tempDir: string;
  private sessionDir: string;
  private thinkingLog: string[] = [];

  constructor() {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-session-'));
    this.sessionDir = path.join(this.tempDir, 'session');
    fs.mkdirSync(this.sessionDir, { recursive: true });
  }

  buildPrompt(options: QwenSessionOptions): string {
    const {
      targetFile,
      fullFileContent,
      startLine,
      endLine,
      reviewComment,
      previousPatch,
      previousError,
      suggestedFixes,
      committableSuggestions,
    } = options;

    let prompt = `You are a code editor AI. Your task is to fix a code review comment by editing files directly.

## TARGET FILE
File: ${targetFile}
Lines: ${startLine}-${endLine}

## FULL FILE CONTENT
\`\`\`
${fullFileContent}
\`\`\`

## REVIEW COMMENT
${reviewComment}
`;

    if (suggestedFixes && suggestedFixes.length > 0) {
      prompt += `
## SUGGESTED FIXES (use as starting point)
These are suggested fixes from the reviewer:
\`\`\`
${suggestedFixes.join('\n\n')}
\`\`\`
`;
    }

    if (committableSuggestions && committableSuggestions.length > 0) {
      prompt += `
## COMMITTABLE SUGGESTIONS
These are formatted code suggestions ready to commit:
\`\`\`
${committableSuggestions.join('\n\n')}
\`\`\`
`;
    }

    if (previousPatch && previousError) {
      prompt += `
## PREVIOUS ATTEMPT (FAILED)
A previous LLM generated this patch but it failed:
\`\`\`diff
${previousPatch}
\`\`\`

Error: ${previousError}

Analyze why this failed and fix it properly.
`;
    }

    prompt += `
## INSTRUCTIONS
1. Read the full file content above
2. Understand what needs to be fixed based on the review comment
3. Use the suggested fixes as a starting point
4. Make the necessary edits
5. Return JSON in this format:
\`\`\`json
{
  "thinking": "Your reasoning about the fix",
  "edits": [
    {
      "file": "${targetFile}",
      "changes": [
        {
          "startLine": <line number>,
          "endLine": <line number>,
          "oldContent": "<exact content to replace>",
          "newContent": "<new content>"
        }
      ]
    }
  ],
  "additionalFiles": [
    {"file": "path/to/other/file", "reason": "why this file needs changes"}
  ]
}
\`\`\`
`;
    return prompt;
  }

  parseResponse(response: string): { thinking: string; edits: any[]; additionalFiles: any[] } {
    this.thinkingLog.push(response);
    
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        const json = JSON.parse(jsonMatch[1]);
        return {
          thinking: json.thinking || '',
          edits: json.edits || [],
          additionalFiles: json.additionalFiles || [],
        };
      } catch (e) {
        log.warn(`Failed to parse JSON from response: ${e}`);
      }
    }

    const jsonStart = response.indexOf('{');
    const jsonEnd = response.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) {
      try {
        const json = JSON.parse(response.slice(jsonStart, jsonEnd + 1));
        return {
          thinking: json.thinking || '',
          edits: json.edits || [],
          additionalFiles: json.additionalFiles || [],
        };
      } catch (e) {
        log.warn(`Failed to parse JSON object from response`);
      }
    }

    return { thinking: response, edits: [], additionalFiles: [] };
  }

  applyEdits(content: string, edits: Array<{ startLine: number; endLine: number; oldContent: string; newContent: string }>): string {
    const lines = content.split('\n');
    
    for (const edit of edits) {
      const before = lines.slice(0, edit.startLine - 1);
      const after = lines.slice(edit.endLine);
      const newLines = edit.newContent.split('\n');
      lines.length = 0;
      lines.push(...before, ...newLines, ...after);
    }
    
    return lines.join('\n');
  }

  async runSession(options: QwenSessionOptions): Promise<QwenSessionResult> {
    const { maxRounds, workDir, targetFile, fullFileContent } = options;
    let currentContent = fullFileContent;
    let rounds = 0;
    let lastThinking = '';
    let lastError: string | undefined;

    for (let round = 0; round < maxRounds; round++) {
      rounds++;
      log.step(`Round ${round + 1}/${maxRounds}`);

      const prompt = this.buildPrompt({
        ...options,
        fullFileContent: currentContent,
        previousError: lastError,
      });

      const promptFile = path.join(this.sessionDir, `prompt-${round}.txt`);
      fs.writeFileSync(promptFile, prompt);

      try {
        log.step(`Calling Qwen CLI...`);
        const response = execSync(`qwen "$(cat ${promptFile})"`, {
          cwd: workDir,
          stdio: 'pipe',
          timeout: 300000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, NO_COLOR: '1' },
        }).toString().trim();

        log.thinking(`Response length: ${response.length} chars`);
        
        if (options.onThinking) {
          options.onThinking(response);
        }

        const parsed = this.parseResponse(response);
        lastThinking = parsed.thinking;

        if (parsed.edits.length === 0) {
          log.warn(`No edits found in response`);
          lastError = 'No edits found in response';
          continue;
        }

        const fileEdit = parsed.edits.find((e: any) => e.file === targetFile || !e.file);
        if (fileEdit && fileEdit.changes && fileEdit.changes.length > 0) {
          try {
            const newContent = this.applyEdits(currentContent, fileEdit.changes);
            currentContent = newContent;
            
            log.success(`Applied ${fileEdit.changes.length} edits successfully`);
            
            return {
              success: true,
              editedContent: newContent,
              thinking: lastThinking,
              additionalEdits: parsed.additionalFiles,
              rounds,
            };
          } catch (e: any) {
            log.error(`Failed to apply edits: ${e.message}`);
            lastError = e.message;
          }
        }
      } catch (e: any) {
        log.error(`Qwen CLI failed: ${e.message}`);
        lastError = e.message;
      }
    }

    return {
      success: false,
      error: `Failed to generate valid edits after ${rounds} rounds`,
      thinking: lastThinking,
      rounds,
    };
  }

  getThinkingLog(): string[] {
    return this.thinkingLog;
  }

  cleanup(): void {
    try {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}
