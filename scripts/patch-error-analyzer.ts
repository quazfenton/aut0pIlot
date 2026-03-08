import * as fs from 'fs';
import * as path from 'path';

export interface PatchErrorAnalysis {
  success: boolean;
  errorType: 'line_mismatch' | 'context_mismatch' | 'whitespace' | 'hunk_header' | 'missing_file' | 'unknown';
  lineNumber?: number;
  expectedContent?: string;
  actualContent?: string;
  hunkHeader?: string;
  suggestions: string[];
  rawError: string;
}

export interface LineMismatch {
  patchLine: number;
  fileLine: number;
  expected: string;
  actual: string;
  type: 'removal' | 'addition' | 'context';
}

export interface DiffHighlight {
  patchFile: string;
  patchStartLine: number;
  patchEndLine: number;
  fileStartLine: number;
  fileEndLine: number;
  patchLines: string[];
  fileLines: string[];
  mismatches: LineMismatch[];
  visualDiff: string;
}

const log = {
  analyze: (msg: string) => console.log(`\x1b[38;5;221m[ANALYZE]\x1b[0m ${msg}`),
  error: (msg: string) => console.log(`\x1b[31m[ANALYZE-ERR]\x1b[0m ${msg}`),
  suggest: (msg: string) => console.log(`\x1b[33m[SUGGEST]\x1b[0m ${msg}`),
  highlight: (msg: string) => console.log(`\x1b[38;5;117m[HIGHLIGHT]\x1b[0m ${msg}`),
};

export class PatchErrorAnalyzer {
  /**
   * Analyze a git apply error and extract actionable information
   */
  analyzeGitError(errorOutput: string, patchContent: string, fileContent: string): PatchErrorAnalysis {
    log.analyze(`Analyzing git error (${errorOutput.length} chars)`);

    const result: PatchErrorAnalysis = {
      success: false,
      errorType: 'unknown',
      suggestions: [],
      rawError: errorOutput,
    };

    // Pattern 1: "error: patch failed: <file>:<line>"
    const patchFailedMatch = errorOutput.match(/error: patch failed: .+?:(\d+)/);
    if (patchFailedMatch) {
      result.errorType = 'line_mismatch';
      result.lineNumber = parseInt(patchFailedMatch[1], 10);
      log.analyze(`Detected line mismatch at line ${result.lineNumber}`);
    }

    // Pattern 2: "error: <file>: patch does not apply"
    const patchNotApplyMatch = errorOutput.match(/error: .+?: patch does not apply/);
    if (patchNotApplyMatch) {
      result.errorType = 'context_mismatch';
      log.analyze(`Detected context mismatch`);
    }

    // Pattern 3: Hunk header error - "error: corrupt patch at line N"
    const corruptPatchMatch = errorOutput.match(/error: corrupt patch at line (\d+)/);
    if (corruptPatchMatch) {
      result.errorType = 'hunk_header';
      result.lineNumber = parseInt(corruptPatchMatch[1], 10);
      log.analyze(`Detected corrupt patch at line ${result.lineNumber}`);
    }

    // Pattern 4: Whitespace issues
    if (errorOutput.includes('whitespace') || errorOutput.includes('trailing whitespace')) {
      result.errorType = 'whitespace';
      log.analyze(`Detected whitespace issue`);
    }

    // Pattern 5: Missing file
    if (errorOutput.includes('does not exist in index') || errorOutput.includes('No such file')) {
      result.errorType = 'missing_file';
      log.analyze(`Detected missing file`);
    }

    // Extract hunk header for analysis
    const hunkHeaderMatch = patchContent.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
    if (hunkHeaderMatch) {
      result.hunkHeader = hunkHeaderMatch[0];
    }

    // Generate specific suggestions based on error type
    result.suggestions = this.generateSuggestions(result, patchContent, fileContent, errorOutput);

    return result;
  }

  /**
   * Generate actionable suggestions for fixing the patch
   */
  private generateSuggestions(
    analysis: PatchErrorAnalysis,
    patchContent: string,
    fileContent: string,
    errorOutput: string
  ): string[] {
    const suggestions: string[] = [];

    switch (analysis.errorType) {
      case 'line_mismatch':
        suggestions.push('The context lines in the patch do not match the actual file content.');
        suggestions.push('Check if the file has been modified since the patch was generated.');
        suggestions.push('Verify line numbers in the @@ hunk header match actual content.');
        suggestions.push('Compare expected context lines with actual file content around the target line.');
        break;

      case 'context_mismatch':
        suggestions.push('The patch context does not match the file at the specified location.');
        suggestions.push('Ensure 3 lines of context before and after the change are accurate.');
        suggestions.push('Check for hidden whitespace differences (tabs vs spaces).');
        suggestions.push('Verify the file path is correct and the file exists.');
        break;

      case 'hunk_header':
        suggestions.push('The @@ hunk header is malformed or incomplete.');
        suggestions.push('Ensure the hunk header follows format: @@ -oldStart,oldCount +newStart,newCount @@');
        suggestions.push('Check for missing line numbers or counts in the header.');
        break;

      case 'whitespace':
        suggestions.push('There are whitespace differences between the patch and file.');
        suggestions.push('Try using --ignore-space-change or --ignore-whitespace flags.');
        suggestions.push('Check for trailing spaces or mixed tabs/spaces.');
        suggestions.push('Normalize line endings (LF vs CRLF).');
        break;

      case 'missing_file':
        suggestions.push('The target file does not exist at the specified path.');
        suggestions.push('Verify the file path in the patch header (--- a/path and +++ b/path).');
        suggestions.push('Check if the file was moved or renamed.');
        break;

      default:
        suggestions.push('Unknown patch error. Try regenerating the patch from scratch.');
        suggestions.push('Verify the base commit SHA is correct.');
        suggestions.push('Check for any file system or encoding issues.');
    }

    return suggestions;
  }

  /**
   * Parse a unified diff to extract line-by-line changes
   */
  parseUnifiedDiff(patchContent: string): { hunks: Array<{ header: string; lines: string[] }> } {
    const hunks: Array<{ header: string; lines: string[] }> = [];
    const lines = patchContent.split('\n');
    
    let currentHunk: { header: string; lines: string[] } | null = null;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }
        currentHunk = { header: line, lines: [] };
      } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '')) {
        currentHunk.lines.push(line);
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk);
    }

    return { hunks };
  }

  /**
   * Find exact line mismatches between patch context and file content
   */
  findLineMismatches(
    patchContent: string,
    fileLines: string[],
    startLine: number
  ): LineMismatch[] {
    const mismatches: LineMismatch[] = [];
    const { hunks } = this.parseUnifiedDiff(patchContent);

    for (const hunk of hunks) {
      const headerMatch = hunk.header.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (!headerMatch) continue;

      const oldStart = parseInt(headerMatch[1], 10);
      const newStart = parseInt(headerMatch[2], 10);

<<<<<<< HEAD
      // FIX: Use startLine parameter to compute proper offset
      // The fileLines array might be a slice starting at startLine
      const offset = startLine > 1 ? startLine - 1 : 0;
      let fileLineIdx = oldStart - 1 + offset;
=======
      let fileLineIdx = (oldStart - 1) + (startLine - 1);
      let patchLineIdx = 0;

      for (const patchLine of hunk.lines) {
        if (patchLine.startsWith('-')) {
          // Context line - should match file
>>>>>>> origin/autopilot/pr-2-fixes
      let patchLineIdx = 0;

      for (const patchLine of hunk.lines) {
        if (patchLine.startsWith('-')) {
          // Context line - should match file
          const expected = patchLine.substring(1);
          const actual = fileLines[fileLineIdx] || '';

          if (expected !== actual) {
            mismatches.push({
              patchLine: patchLineIdx,
              fileLine: fileLineIdx + 1,
              expected,
              actual,
              type: 'removal',
            });
          }
          fileLineIdx++;
        } else if (patchLine.startsWith('+')) {
          // Addition - doesn't affect file line position
          patchLineIdx++;
          continue;
        } else if (patchLine.startsWith(' ') || patchLine === '') {
          // Context line - should match file
          const expected = patchLine.startsWith(' ') ? patchLine.substring(1) : '';
          const actual = fileLines[fileLineIdx] || '';
          
          if (expected !== actual) {
            mismatches.push({
              patchLine: patchLineIdx,
              fileLine: fileLineIdx + 1,
              expected,
              actual,
              type: 'context',
            });
          }
          fileLineIdx++;
        }
        patchLineIdx++;
      }
    }

    return mismatches;
  }

  /**
   * Generate a detailed error report for Qwen feedback
   */
  generateQwenFeedback(
    analysis: PatchErrorAnalysis,
    patchContent: string,
    fileContent: string,
    filePath: string
  ): string {
    const fileLines = fileContent.split('\n');
    const mismatches = this.findLineMismatches(patchContent, fileLines, 1);

    let feedback = `## Patch Error Analysis for ${filePath}\n\n`;
    feedback += `**Error Type:** ${analysis.errorType}\n\n`;
    
    if (analysis.lineNumber) {
      feedback += `**Error Location:** Line ${analysis.lineNumber}\n\n`;
    }

    feedback += `### Git Error Output\n\`\`\`\n${analysis.rawError.substring(0, 1000)}\n\`\`\`\n\n`;

    if (mismatches.length > 0) {
      feedback += `### Line Mismatches Found\n\n`;
      for (const m of mismatches.slice(0, 5)) {
        feedback += `- **Line ${m.fileLine}**\n`;
        feedback += `  - Expected: \`${m.expected}\`\n`;
        feedback += `  - Actual: \`${m.actual}\`\n\n`;
      }
      if (mismatches.length > 5) {
        feedback += `... and ${mismatches.length - 5} more mismatches.\n\n`;
      }
    }

    feedback += `### Suggestions to Fix\n\n`;
    for (const suggestion of analysis.suggestions) {
      feedback += `- ${suggestion}\n`;
    }

    feedback += `\n### File Context (around error)\n\n`;
    
    if (analysis.lineNumber) {
      const contextStart = Math.max(0, analysis.lineNumber - 5);
      const contextEnd = Math.min(fileLines.length, analysis.lineNumber + 5);
      
      for (let i = contextStart; i < contextEnd; i++) {
        const lineNum = i + 1;
        const marker = lineNum === analysis.lineNumber ? '>>>' : '   ';
        feedback += `${marker} ${lineNum}: ${fileLines[i]}\n`;
      }
    }

    return feedback;
  }

  /**
   * Create a retry prompt for Qwen with error feedback
   */
  createRetryPrompt(
    originalPrompt: string,
    analysis: PatchErrorAnalysis,
    patchContent: string,
    fileContent: string,
    filePath: string
  ): string {
    const feedback = this.generateQwenFeedback(analysis, patchContent, fileContent, filePath);

    return `${originalPrompt}

---

## PREVIOUS PATCH FAILED

The previous patch you generated could not be applied. Here is the detailed error analysis:

${feedback}

## INSTRUCTIONS FOR RETRY

Please generate a NEW patch that addresses these issues:

1. **Use the EXACT content from the file context above** - copy lines exactly as they appear
2. **Match whitespace exactly** - including spaces, tabs, and line endings
3. **Use correct line numbers** in the @@ hunk header
4. **Include 3 lines of context** before and after your changes
5. **Format as unified diff** with proper --- a/file and +++ b/file headers

Generate the corrected patch now:`;
  }

  /**
   * Generate a visual side-by-side diff highlighting mismatches
   */
  generateDiffHighlight(
    patchContent: string,
    fileContent: string,
    filePath: string
  ): DiffHighlight {
    const fileLines = fileContent.split('\n');
    
    // Handle null/undefined patch content
    if (!patchContent) {
      return {
        patchFile: filePath,
        patchStartLine: 0,
        patchEndLine: 0,
        fileStartLine: 0,
        fileEndLine: 0,
        patchLines: [],
        fileLines: [],
        mismatches: [],
        visualDiff: 'No patch content provided'
      };
    }
    
    const { hunks } = this.parseUnifiedDiff(patchContent);
    
    if (hunks.length === 0) {
      return {
        patchFile: filePath,
        patchStartLine: 0,
        patchEndLine: 0,
        fileStartLine: 0,
        fileEndLine: 0,
        patchLines: [],
        fileLines: [],
        mismatches: [],
        visualDiff: 'No hunks found in patch'
      };
    }

    const hunk = hunks[0];
    const headerMatch = hunk.header.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
    
    if (!headerMatch) {
      return {
        patchFile: filePath,
        patchStartLine: 0,
        patchEndLine: 0,
        fileStartLine: 0,
        fileEndLine: 0,
        patchLines: [],
        fileLines: [],
        mismatches: [],
        visualDiff: 'Could not parse hunk header'
      };
    }

    const oldStart = parseInt(headerMatch[1], 10);
    const oldCount = parseInt(headerMatch[2] || '1', 10);
    
    // Extract patch lines and file lines for comparison
    const patchLines: string[] = [];
    const removedLines: string[] = [];
    const addedLines: string[] = [];

    for (const line of hunk.lines) {
      if (line.startsWith(' ')) {
        patchLines.push(line.substring(1));
      } else if (line.startsWith('-')) {
        removedLines.push(line.substring(1));
      } else if (line.startsWith('+')) {
        addedLines.push(line.substring(1));
      }
    }

    // Get corresponding file lines
    const fileStartLine = Math.max(0, oldStart - 1);
    const fileEndLine = Math.min(fileLines.length, oldStart + oldCount + 2);
    const correspondingFileLines = fileLines.slice(fileStartLine, fileEndLine);

    // Find mismatches
    const mismatches = this.findLineMismatches(patchContent, fileLines, oldStart);

    // Generate visual diff
    const visualDiff = this.createVisualDiff(
      patchLines,
      removedLines,
      addedLines,
      correspondingFileLines,
      mismatches,
      oldStart
    );

    return {
      patchFile: filePath,
      patchStartLine: oldStart,
      patchEndLine: oldStart + oldCount,
      fileStartLine: fileStartLine + 1,
      fileEndLine,
      patchLines,
      fileLines: correspondingFileLines,
      mismatches,
      visualDiff
    };
  }

  /**
   * Create a visual side-by-side diff display
   */
  private createVisualDiff(
    patchLines: string[],
    removedLines: string[],
    addedLines: string[],
    fileLines: string[],
    mismatches: LineMismatch[],
    startLine: number
  ): string {
    const output: string[] = [];
    
    output.push('\n╔════════════════════════════════════════════════════════════════╗');
    output.push('║                    PATCH vs FILE COMPARISON                     ║');
    output.push('╚════════════════════════════════════════════════════════════════╝\n');

    // Create mismatch lookup
    const mismatchMap = new Map<number, LineMismatch>();
    for (const m of mismatches) {
      mismatchMap.set(m.fileLine, m);
    }

    // Show file content with highlights
    output.push('📄 FILE CONTENT (with mismatches highlighted):');
    output.push('─'.repeat(70));
    
    for (let i = 0; i < fileLines.length; i++) {
      const lineNum = startLine + i;
      const mismatch = mismatchMap.get(lineNum);
      
      if (mismatch) {
        output.push(`\x1b[31m${lineNum.toString().padStart(4)} | ${mismatch.actual}\x1b[0m`);
        output.push(`\x1b[33m     | Expected: ${mismatch.expected}\x1b[0m`);
        output.push(`\x1b[33m     | ❌ MISMATCH (type: ${mismatch.type})\x1b[0m`);
      } else {
        output.push(`\x1b[32m${lineNum.toString().padStart(4)} | ${fileLines[i]}\x1b[0m`);
      }
    }

    output.push('\n📝 PATCH CONTENT:');
    output.push('─'.repeat(70));

    // Show patch content
    for (const line of patchLines) {
      output.push(`      | ${line}`);
    }

    if (removedLines.length > 0) {
      output.push('\n\x1b[31mRemoved lines:\x1b[0m');
      for (const line of removedLines) {
        output.push(`\x1b[31m  -   | ${line}\x1b[0m`);
      }
    }

    if (addedLines.length > 0) {
      output.push('\n\x1b[32mAdded lines:\x1b[0m');
      for (const line of addedLines) {
        output.push(`\x1b[32m  +   | ${line}\x1b[0m`);
      }
    }

    // Summary
    output.push('\n📊 SUMMARY:');
    output.push('─'.repeat(70));
    output.push(`Total mismatches: ${mismatches.length}`);
    output.push(`File lines shown: ${fileLines.length}`);
    output.push(`Patch lines: ${patchLines.length}`);
    output.push(`Removed: ${removedLines.length}, Added: ${addedLines.length}`);

    if (mismatches.length > 0) {
      output.push('\n\x1b[31m⚠️  ERRORS:\x1b[0m');
      for (const m of mismatches.slice(0, 5)) {
        output.push(`  Line ${m.fileLine}: "${m.actual.substring(0, 50)}"`);
        output.push(`    Expected: "${m.expected.substring(0, 50)}"`);
      }
      if (mismatches.length > 5) {
        output.push(`  ... and ${mismatches.length - 5} more`);
      }
    }

    output.push('\n');
    return output.join('\n');
  }

  /**
   * Generate enhanced error report with visual diff
   */
  generateEnhancedErrorReport(
    analysis: PatchErrorAnalysis,
    patchContent: string,
    fileContent: string,
    filePath: string
  ): string {
    const fileLines = fileContent.split('\n');
    const diffHighlight = this.generateDiffHighlight(patchContent, fileContent, filePath);

    let report = `# Patch Error Report for ${filePath}\n\n`;
    
    report += `## Error Summary\n`;
    report += `- **Type**: ${analysis.errorType}\n`;
    report += `- **Raw Error**: ${analysis.rawError.substring(0, 500)}\n\n`;

    report += diffHighlight.visualDiff;

    report += `\n## Suggestions to Fix\n\n`;
    for (const suggestion of analysis.suggestions) {
      report += `- ${suggestion}\n`;
    }

    return report;
  }

  /**
   * Log enhanced error report to console with colors
   */
  logEnhancedError(
    analysis: PatchErrorAnalysis,
    patchContent: string,
    fileContent: string,
    filePath: string
  ): void {
    const report = this.generateEnhancedErrorReport(analysis, patchContent, fileContent, filePath);
    
    console.log('\n\x1b[1;31m╔══════════════════════════════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[1;31m║              PATCH APPLICATION ERROR REPORT                   ║\x1b[0m');
    console.log('\x1b[1;31m╚══════════════════════════════════════════════════════════════╝\x1b[0m\n');
    
    console.log(report);
  }
}

export const patchErrorAnalyzer = new PatchErrorAnalyzer();
