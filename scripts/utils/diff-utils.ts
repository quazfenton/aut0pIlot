import { createTwoFilesPatch, diffLines, Change } from 'diff';
import parseDiffModule from 'parse-diff';

// parse-diff exports a function directly as default export
const parse = parseDiffModule;

// Type definition for parsed patch (since parse-diff types may vary)
interface ParsedPatch {
  from?: string;
  to?: string;
  chunks?: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    content?: string;
    changes?: Array<{ type: string; content?: string }>;
  }>;
}

export interface DiffOptions {
  contextLines?: number;
  oldFileName: string;
  newFileName: string;
  oldLabel?: string;
  newLabel?: string;
}

export interface DiffValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    filesChanged: number;
    hunksCount: number;
    linesAdded: number;
    linesRemoved: number;
  };
}

export interface GitApplyError {
  lineNumber?: number;
  file?: string;
  errorType: 'context_mismatch' | 'removal_mismatch' | 'whitespace' | 'already_applied' | 'corrupt_patch' | 'missing_file';
  expected?: string;
  actual?: string;
  suggestion: string;
  rawError: string;
}

export class DiffUtils {
  /**
   * Generate high-quality unified diff using diff library
   * This ensures proper context lines, correct hunk headers, and git apply compatibility
   */
  static generateUnifiedDiff(
    oldContent: string,
    newContent: string,
    options: DiffOptions
  ): string {
    const {
      contextLines = 3,
      oldFileName,
      newFileName,
      oldLabel = 'a/' + oldFileName,
      newLabel = 'b/' + newFileName
    } = options;

    // Handle empty file cases
    if (!oldContent && newContent) {
      // New file
      const lines = newContent.split('\n');
      let patch = `--- /dev/null\n`;
      patch += `+++ b/${newFileName}\n`;
      patch += `@@ -0,0 +1,${lines.length} @@\n`;
      for (const line of lines) {
        patch += `+${line}\n`;
      }
      return patch;
    }

    if (oldContent && !newContent) {
      // Deleted file
      const lines = oldContent.split('\n');
      let patch = `--- a/${oldFileName}\n`;
      patch += `+++ /dev/null\n`;
      patch += `@@ -1,${lines.length} +0,0 @@\n`;
      for (const line of lines) {
        patch += `-${line}\n`;
      }
      return patch;
    }

    // Use diff library for proper unified diff generation
    try {
      // Correct signature: createTwoFilesPatch(oldFileName, newFileName, oldContent, newContent, oldHeader, newHeader, options)
      const patch = createTwoFilesPatch(
        oldFileName,
        newFileName,
        oldContent,
        newContent,
        undefined,  // oldHeader (optional)
        undefined,  // newHeader (optional)
        { context: contextLines }
      );

      return patch;
    } catch (error: any) {
      // Fallback to manual diff generation
      console.warn(`diff library failed, using fallback: ${error.message}`);
      return this.generateFallbackDiff(oldContent, newContent, options);
    }
  }

  /**
   * Fallback diff generation when diff library fails
   */
  private static generateFallbackDiff(
    oldContent: string,
    newContent: string,
    options: DiffOptions
  ): string {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    // Find first and last changed lines
    let firstChange = -1;
    let lastChange = -1;

    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      if (oldLines[i] !== newLines[i]) {
        if (firstChange === -1) firstChange = i;
        lastChange = i;
      }
    }

    if (firstChange === -1) {
      // No changes
      return '';
    }

    // Add context (3 lines before and after)
    const contextBefore = Math.min(3, firstChange);
    const contextAfter = Math.min(3, oldLines.length - lastChange - 1);

    const hunkStart = firstChange - contextBefore;
    const oldCount = contextBefore + (lastChange - firstChange + 1) + contextAfter;
    const newCount = contextBefore + (newLines.length - oldLines.length) + oldCount;

    let patch = `--- a/${options.oldFileName}\n`;
    patch += `+++ b/${options.newFileName}\n`;
    patch += `@@ -${hunkStart + 1},${oldCount} +${hunkStart + 1},${newCount} @@\n`;

    // Context before
    for (let i = hunkStart; i < firstChange; i++) {
      patch += ` ${oldLines[i]}\n`;
    }

    // Changes (simplified - show all removals then all additions)
    for (let i = firstChange; i <= lastChange && i < oldLines.length; i++) {
      patch += `-${oldLines[i]}\n`;
    }

    for (let i = firstChange; i <= lastChange && i < newLines.length; i++) {
      patch += `+${newLines[i]}\n`;
    }

    // Context after
    for (let i = lastChange + 1; i < lastChange + 1 + contextAfter && i < oldLines.length; i++) {
      patch += ` ${oldLines[i]}\n`;
    }

    return patch;
  }

  /**
   * Comprehensive diff validation
   */
  static validateDiff(patch: string): DiffValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const stats = {
      filesChanged: 0,
      hunksCount: 0,
      linesAdded: 0,
      linesRemoved: 0
    };

    // Check basic structure
    if (!patch || patch.trim().length === 0) {
      errors.push('Empty patch');
      return { valid: false, errors, warnings, stats };
    }

    if (!patch.includes('--- ') && !patch.includes('--- /dev/null')) {
      errors.push('Missing --- header (old file)');
    }

    if (!patch.includes('+++ ') && !patch.includes('+++ /dev/null')) {
      errors.push('Missing +++ header (new file)');
    }

    if (!patch.includes('@@')) {
      errors.push('Missing @@ hunk marker');
    }

    // Parse with parse-diff for detailed validation
    try {
      const parsed: ParsedPatch[] = parse(patch);

      if (parsed.length === 0) {
        errors.push('No valid hunks parsed');
      }

      stats.filesChanged = parsed.length;

      for (const file of parsed) {
        if (!file.chunks || file.chunks.length === 0) {
          errors.push(`No chunks found for ${file.from || file.to}`);
          continue;
        }

        stats.hunksCount += file.chunks.length;

        for (const chunk of file.chunks) {
          const changes = chunk.changes || [];
          const adds = changes.filter(c => c.type === 'add').length;
          const dels = changes.filter(c => c.type === 'del').length;

          stats.linesAdded += adds;
          stats.linesRemoved += dels;

          if (adds === 0 && dels === 0) {
            warnings.push(`Hunk at line ${chunk.oldStart} has no actual changes`);
          }

          // Check for potentially problematic patterns
          this.checkChangePatterns(changes, warnings, chunk.oldStart);
        }

        // Check for balanced quotes/brackets in added lines
        this.checkBalancedSymbols(file, warnings);
      }
    } catch (error: any) {
      errors.push(`Parse error: ${error.message}`);
    }

    // Additional validation checks
    this.checkPatchPatterns(patch, errors, warnings);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      stats
    };
  }

  /**
   * Check for problematic change patterns
   */
  private static checkChangePatterns(
    changes: Array<{ type: string; content?: string }>,
    warnings: string[],
    hunkLine: number
  ): void {
    let consecutiveAdds = 0;
    let consecutiveDels = 0;
    let maxConsecutiveAdds = 0;
    let maxConsecutiveDels = 0;

    for (const change of changes) {
      if (change.type === 'add') {
        consecutiveAdds++;
        consecutiveDels = 0;
        maxConsecutiveAdds = Math.max(maxConsecutiveAdds, consecutiveAdds);
      } else if (change.type === 'del') {
        consecutiveDels++;
        consecutiveAdds = 0;
        maxConsecutiveDels = Math.max(maxConsecutiveDels, consecutiveDels);
      } else {
        consecutiveAdds = 0;
        consecutiveDels = 0;
      }
    }

    // Warn about large blocks of additions without context
    if (maxConsecutiveAdds > 20) {
      warnings.push(`Large block of additions (${maxConsecutiveAdds} lines) - consider adding context`);
    }

    // Warn about large blocks of deletions
    if (maxConsecutiveDels > 20) {
      warnings.push(`Large block of deletions (${maxConsecutiveDels} lines) - verify this is intentional`);
    }

    // Check for duplicate added lines
    const addedLines = changes
      .filter(c => c.type === 'add' && c.content)
      .map(c => c.content!.trim());

    const duplicates = addedLines.filter(
      (line, index) => addedLines.indexOf(line) !== index
    );

    if (duplicates.length > 0) {
      warnings.push(`Duplicate added lines detected: "${duplicates[0]?.substring(0, 50)}..."`);
    }
  }

  /**
   * Check for balanced symbols in added content
   */
  private static checkBalancedSymbols(
    file: ParsedPatch,
    warnings: string[]
  ): void {
    if (!file.chunks) return;

    for (const chunk of file.chunks) {
      const addedContent = chunk.changes
        ?.filter(c => c.type === 'add' && c.content)
        .map(c => c.content!)
        .join('\n') || '';

      // Count brackets
      const openBraces = (addedContent.match(/{/g) || []).length;
      const closeBraces = (addedContent.match(/}/g) || []).length;
      const openParens = (addedContent.match(/\(/g) || []).length;
      const closeParens = (addedContent.match(/\)/g) || []).length;
      const openBrackets = (addedContent.match(/\[/g) || []).length;
      const closeBrackets = (addedContent.match(/\]/g) || []).length;

      // Warn about severely unbalanced symbols (allowing some tolerance for multi-line constructs)
      if (Math.abs(openBraces - closeBraces) > 3) {
        warnings.push(`Unbalanced braces in added content (${openBraces} open, ${closeBraces} close)`);
      }

      if (Math.abs(openParens - closeParens) > 3) {
        warnings.push(`Unbalanced parentheses in added content`);
      }

      if (Math.abs(openBrackets - closeBrackets) > 3) {
        warnings.push(`Unbalanced brackets in added content`);
      }
    }
  }

  /**
   * Check overall patch patterns
   */
  private static checkPatchPatterns(
    patch: string,
    errors: string[],
    warnings: string[]
  ): void {
    const lines = patch.split('\n');

    // Check for trailing whitespace in added lines
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('+') && !line.startsWith('+++')) {
        if (line.endsWith(' ') || line.endsWith('\t')) {
          warnings.push(`Line ${i + 1}: Added line has trailing whitespace`);
        }
      }
    }

    // Check for mixed indentation
    const addedLines = lines.filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const hasTabs = addedLines.some(l => l.includes('\t'));
    const hasSpaces = addedLines.some(l => l.match(/^\+ {2,}/));

    if (hasTabs && hasSpaces) {
      warnings.push('Mixed tabs and spaces detected in added lines');
    }

    // Check for no-op patch (same additions and removals)
    const removedLinesForNoop = lines
      .filter(l => l.startsWith('-') && !l.startsWith('---'))
      .map(l => l.substring(1));

    const addedLinesForNoop = lines
      .filter(l => l.startsWith('+') && !l.startsWith('+++'))
      .map(l => l.substring(1));

    if (removedLinesForNoop.length === addedLinesForNoop.length) {
      const allMatch = removedLinesForNoop.every((line, i) => line === addedLinesForNoop[i]);
      if (allMatch) {
        warnings.push('Patch appears to be a no-op (same lines removed and added)');
      }
    }
  }

  /**
   * Parse git apply error output into structured format
   */
  static parseGitApplyError(errorOutput: string, patch?: string): GitApplyError {
    const rawError = errorOutput || 'Unknown error';

    // Pattern 1: "error: patch failed: <file>:<line>"
    const patchFailedMatch = errorOutput.match(/error: patch failed: .+?:(\d+)/);
    if (patchFailedMatch) {
      return {
        lineNumber: parseInt(patchFailedMatch[1], 10),
        errorType: 'context_mismatch',
        suggestion: 'Context lines in patch do not match actual file content. Fetch actual file and regenerate diff.',
        rawError
      };
    }

    // Pattern 2: "error: <file>: patch does not apply"
    if (errorOutput.includes('patch does not apply')) {
      return {
        errorType: 'context_mismatch',
        suggestion: 'Patch context mismatch. Ensure 3 lines of context before/after changes match exactly.',
        rawError
      };
    }

    // Pattern 3: "error: corrupt patch at line N"
    const corruptMatch = errorOutput.match(/error: corrupt patch at line (\d+)/);
    if (corruptMatch) {
      return {
        lineNumber: parseInt(corruptMatch[1], 10),
        errorType: 'corrupt_patch',
        suggestion: 'Patch format is malformed. Regenerate using proper unified diff format.',
        rawError
      };
    }

    // Pattern 4: Whitespace issues
    if (errorOutput.includes('whitespace') || errorOutput.includes('trailing whitespace')) {
      return {
        errorType: 'whitespace',
        suggestion: 'Whitespace differences detected. Use --ignore-space-change or normalize whitespace.',
        rawError
      };
    }

    // Pattern 5: Missing file
    if (errorOutput.includes('does not exist in index') || errorOutput.includes('No such file')) {
      return {
        errorType: 'missing_file',
        suggestion: 'Target file does not exist. Verify file path is correct.',
        rawError
      };
    }

    // Pattern 6: Already applied
    if (errorOutput.includes('already applied') || errorOutput.includes('patch applied')) {
      return {
        errorType: 'already_applied',
        suggestion: 'Patch may already be applied. Check current file state.',
        rawError
      };
    }

    // Default: unknown error
    return {
      errorType: 'context_mismatch',
      suggestion: 'Unknown patch error. Try regenerating the patch from scratch.',
      rawError
    };
  }

  /**
   * Normalize whitespace for comparison
   */
  static normalizeWhitespace(content: string): string {
    return content
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n')
      .replace(/\t/g, '  '); // Normalize tabs to spaces
  }

  /**
   * Check if two contents are semantically equal (ignoring whitespace)
   */
  static semanticallyEqual(a: string, b: string): boolean {
    return this.normalizeWhitespace(a) === this.normalizeWhitespace(b);
  }

  /**
   * Extract changed lines from a patch
   */
  static extractChanges(patch: string): {
    added: string[];
    removed: string[];
    context: string[];
  } {
    const added: string[] = [];
    const removed: string[] = [];
    const context: string[] = [];

    const lines = patch.split('\n');

    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        added.push(line.substring(1));
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        removed.push(line.substring(1));
      } else if (line.startsWith(' ')) {
        context.push(line.substring(1));
      }
    }

    return { added, removed, context };
  }

  /**
   * Compare two patches for semantic equality
   */
  static patchesAreEquivalent(patch1: string, patch2: string): boolean {
    const changes1 = this.extractChanges(patch1);
    const changes2 = this.extractChanges(patch2);

    // Compare added lines (ignoring order for now)
    const added1Sorted = changes1.added.map(l => l.trim()).sort();
    const added2Sorted = changes2.added.map(l => l.trim()).sort();

    const removed1Sorted = changes1.removed.map(l => l.trim()).sort();
    const removed2Sorted = changes2.removed.map(l => l.trim()).sort();

    return JSON.stringify(added1Sorted) === JSON.stringify(added2Sorted) &&
           JSON.stringify(removed1Sorted) === JSON.stringify(removed2Sorted);
  }

  /**
   * Generate a minimal diff by finding the smallest change region
   */
  static minimizeDiff(oldContent: string, newContent: string, options: DiffOptions): string {
    // Use diff library's line-by-line comparison
    const changes: Change[] = diffLines(oldContent, newContent);

    // Find the first and last changed lines
    let firstChange = -1;
    let lastChange = -1;

    let lineNum = 0;
    for (const change of changes) {
      if (change.added || change.removed) {
        if (firstChange === -1) firstChange = lineNum;
        lastChange = lineNum + (change.value.split('\n').length - 1);
      }
      if (!change.removed) {
        lineNum += change.value.split('\n').length - 1;
      }
    }

    // Generate diff with minimal context
    return this.generateUnifiedDiff(oldContent, newContent, {
      ...options,
      contextLines: 1 // Minimal context
    });
  }

  /**
   * Split a multi-file patch into individual file patches
   */
  static splitPatchByFile(patch: string): Array<{ file: string; patch: string }> {
    const parsed: ParsedPatch[] = parse(patch);
    const result: Array<{ file: string; patch: string }> = [];

    for (const file of parsed) {
      // Reconstruct single-file patch
      let singlePatch = `--- a/${file.from}\n`;
      singlePatch += `+++ b/${file.to}\n`;

      for (const chunk of file.chunks || []) {
        // Reconstruct chunk from changes if content is unavailable
        // ParsedPatch chunks may have only 'changes' populated, not 'content'
        if (chunk.content) {
          singlePatch += chunk.content + '\n';
        } else if (chunk.changes && chunk.changes.length > 0) {
          // Reconstruct unified diff format from changes
          singlePatch += `@@ -${chunk.oldStart},${chunk.oldLines} +${chunk.newStart},${chunk.newLines} @@\n`;
          for (const change of chunk.changes) {
            if (change.type === 'add') {
              singlePatch += `+${change.content || ''}\n`;
            } else if (change.type === 'del') {
              singlePatch += `-${change.content || ''}\n`;
            } else if (change.type === 'normal') {
              singlePatch += ` ${change.content || ''}\n`;
            }
          }
        }
      }

      result.push({
        file: file.to || file.from || 'unknown',
        patch: singlePatch.trim()
      });
    }

    return result;
  }

  /**
   * Merge multiple single-file patches into one
   */
  static mergePatches(patches: Array<{ file: string; patch: string }>): string {
    return patches.map(p => p.patch).join('\n\n');
  }
}
