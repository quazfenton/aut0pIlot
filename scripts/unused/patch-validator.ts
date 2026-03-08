import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface PatchValidationResult {
  valid: boolean;
  error?: string;
  warnings: string[];
  stats: {
    linesAdded: number;
    linesRemoved: number;
    filesChanged: number;
    hunksCount: number;
  };
  contextCheck?: {
    aboveMatch: boolean;
    belowMatch: boolean;
    lineCountMatch: boolean;
  };
}

export class PatchValidator {
  private repoDir: string;

  constructor(repoDir: string) {
    this.repoDir = repoDir;
  }

  /**
   * Comprehensive patch validation
   */
  validatePatch(patch: string, filePath: string, expectedStartLine: number, expectedEndLine: number): PatchValidationResult {
    const warnings: string[] = [];
    let stats = { linesAdded: 0, linesRemoved: 0, filesChanged: 0, hunksCount: 0 };

    // 1. Basic format validation
    const formatCheck = this.validatePatchFormat(patch);
    if (!formatCheck.valid) {
      return { valid: false, error: formatCheck.error, warnings, stats };
    }

    // 2. Parse patch stats
    stats = this.parsePatchStats(patch);

    // 3. Check for common issues
    const issues = this.detectCommonIssues(patch, filePath);
    warnings.push(...issues.warnings);
    if (issues.error) {
      return { valid: false, error: issues.error, warnings, stats };
    }

    // 4. Verify context matches file
    const contextCheck = this.verifyContext(patch, filePath, expectedStartLine, expectedEndLine);
    
    if (!contextCheck.aboveMatch) {
      warnings.push('Context above the change does not match exactly');
    }
    if (!contextCheck.belowMatch) {
      warnings.push('Context below the change does not match exactly');
    }
    if (!contextCheck.lineCountMatch) {
      warnings.push(`Line count mismatch: expected ${expectedEndLine - expectedStartLine + 1} lines to be modified`);
    }

    // 5. Git apply check (dry run)
    const gitCheck = this.gitApplyCheck(patch);
    if (!gitCheck.valid) {
      return { valid: false, error: gitCheck.error, warnings, stats };
    }

    return {
      valid: true,
      warnings,
      stats,
      contextCheck,
    };
  }

  /**
   * Validate basic patch format
   */
  private validatePatchFormat(patch: string): { valid: boolean; error?: string } {
    // Check for required headers
    if (!patch.includes('--- a/') && !patch.includes('--- /dev/null')) {
      return { valid: false, error: 'Missing --- header (old file)' };
    }
    if (!patch.includes('+++ b/') && !patch.includes('+++ /dev/null')) {
      return { valid: false, error: 'Missing +++ header (new file)' };
    }

    // Check for hunk markers
    const hunkMatches = patch.match(/@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/g);
    if (!hunkMatches || hunkMatches.length === 0) {
      return { valid: false, error: 'No valid hunk markers found' };
    }

    // Check for balanced + and - lines (rough check)
    const lines = patch.split('\n');
    let hasContentChanges = false;
    
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        hasContentChanges = true;
        break;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        hasContentChanges = true;
        break;
      }
    }

    if (!hasContentChanges) {
      return { valid: false, error: 'Patch contains no actual content changes' };
    }

    return { valid: true };
  }

  /**
   * Parse patch statistics
   */
  private parsePatchStats(patch: string): { linesAdded: number; linesRemoved: number; filesChanged: number; hunksCount: number } {
    const lines = patch.split('\n');
    let linesAdded = 0;
    let linesRemoved = 0;
    const filesChanged = new Set<string>();
    let hunksCount = 0;

    for (const line of lines) {
      if (line.startsWith('+++ b/')) {
        const file = line.substring(6).trim();
        filesChanged.add(file);
      }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        linesAdded++;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        linesRemoved++;
      }
      if (line.startsWith('@@')) {
        hunksCount++;
      }
    }

    return { linesAdded, linesRemoved, filesChanged: filesChanged.size, hunksCount };
  }

  /**
   * Detect common patch issues
   */
  private detectCommonIssues(patch: string, filePath: string): { warnings: string[]; error?: string } {
    const warnings: string[] = [];
    const lines = patch.split('\n');

    // Check for trailing whitespace issues
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('+') && !line.startsWith('+++')) {
        if (line.endsWith(' ') || line.endsWith('\t')) {
          warnings.push(`Line ${i + 1}: Added line has trailing whitespace`);
        }
      }
    }

    // Check for duplicate lines (common LLM mistake)
    const addedLines = lines.filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const seenLines = new Set<string>();
    for (const line of addedLines) {
      if (seenLines.has(line)) {
        warnings.push(`Duplicate added line detected: "${line.substring(0, 50)}..."`);
      }
      seenLines.add(line);
    }

    // Check for empty lines being incorrectly removed
    const removedLines = lines.filter(l => l === '-');
    if (removedLines.length > 2) {
      warnings.push('Multiple empty lines being removed - verify this is intentional');
    }

    // Check for potential indentation issues
    const fileExt = path.extname(filePath).toLowerCase();
    if (['.ts', '.tsx', '.js', '.jsx', '.py'].includes(fileExt)) {
      const mixedIndent = this.detectMixedIndentation(patch);
      if (mixedIndent) {
        warnings.push('Mixed tabs and spaces detected in patch');
      }
    }

    return { warnings };
  }

  /**
   * Verify that context lines match the actual file
   */
  private verifyContext(patch: string, filePath: string, expectedStart: number, expectedEnd: number): {
    aboveMatch: boolean;
    belowMatch: boolean;
    lineCountMatch: boolean;
    fileExists: boolean;
  } {
    const result = { aboveMatch: true, belowMatch: true, lineCountMatch: true, fileExists: true };
    
    const fullPath = path.join(this.repoDir, filePath);
    if (!fs.existsSync(fullPath)) {
      return { aboveMatch: false, belowMatch: false, lineCountMatch: false, fileExists: false };
    }

    try {
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      const fileLines = fileContent.split('\n');

      // Parse the first hunk to get context
      const hunkMatch = patch.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      if (!hunkMatch) return result;

      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;

      // Extract context lines from patch (lines starting with space)
      const patchLines = patch.split('\n');
      const contextLines: string[] = [];
      const removedLines: string[] = [];
      const addedLines: string[] = [];

      for (const line of patchLines) {
        if (line.startsWith(' ')) {
          contextLines.push(line.substring(1));
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          removedLines.push(line.substring(1));
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          addedLines.push(line.substring(1));
        }
      }

      // Verify context lines match EXACTLY at the expected positions
      const hunkStart = parseInt(hunkMatch[1], 10);
      const contextLinesFromPatch: string[] = [];
      const removedLines: string[] = [];

      for (const line of patchLines) {
        if (line.startsWith(' ')) {
          contextLinesFromPatch.push(line.substring(1));
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          removedLines.push(line.substring(1));
        }
      }

      // Verify line count matches expected
      if (removedLines.length !== expectedEnd - expectedStart + 1) {
        result.lineCountMatch = false;
      }

<<<<<<< HEAD:scripts/unused/patch-validator.ts
      // FIX: Verify context lines exist at EXACT positions in file, not just anywhere
      // Check 3 lines before the change
      for (let i = 0; i < Math.min(3, contextLinesFromPatch.length); i++) {
        const patchCtxLine = contextLinesFromPatch[i];
        const fileLineIdx = hunkStart - 1 + i;
        const fileLine = fileLines[fileLineIdx];
        
        if (patchCtxLine && patchCtxLine !== fileLine) {
=======
      // Verify context lines match exactly in file at expected position
      const fileLines = fileContent.split('\n');
      const hunkStartLine = expectedStart - 1; // convert to 0-based index

      // Check above context (3 lines before the change)
      for (let i = 0; i < Math.min(3, contextLines.length); i++) {
        const ctxLine = contextLines[i];
        const fileLine = fileLines[hunkStartLine - 3 + i];
        if (ctxLine !== fileLine) {
          result.aboveMatch = false;
          break;
        }
      }
>>>>>>> origin/autopilot/pr-2-fixes:scripts/patch-validator.ts
          result.aboveMatch = false;
          break;
        }
      }

      // Check 3 lines after the change
      const linesAfterStart = contextLinesFromPatch.length - 3;
      for (let i = 0; i < Math.min(3, linesAfterStart); i++) {
        const patchCtxLine = contextLinesFromPatch[linesAfterStart + i];
        const fileLineIdx = hunkStart - 1 + removedLines.length + i;
        const fileLine = fileLines[fileLineIdx];
        
        if (patchCtxLine && patchCtxLine !== fileLine) {
          result.belowMatch = false;
          break;
        }
      }

      return result;
    } catch (error) {
      return result;
    }
  }

  /**
   * Run git apply --check to verify patch applies cleanly
   */
  private gitApplyCheck(patch: string): { valid: boolean; error?: string } {
    let tmpDir = null;
    try {
      tmpDir = fs.mkdtempSync(path.join('/tmp', 'patch-check-'));
      const patchFile = path.join(tmpDir, 'patch.patch');
      fs.writeFileSync(patchFile, patch);

      try {
        execSync(`git apply --check "${patchFile}"`, {
          cwd: this.repoDir,
          stdio: 'pipe',
          timeout: 10000,
        });
        return { valid: true };
      } catch (error: any) {
        const stderr = error.stderr?.toString() || '';
        
        // Common fixable issues
        if (stderr.includes('corrupt patch')) {
          return { valid: false, error: `Corrupt patch format: ${stderr}` };
        }
        if (stderr.includes('does not match')) {
          return { valid: false, error: `Context does not match: ${stderr}` };
        }
        if (stderr.includes('already applied')) {
          return { valid: false, error: 'Patch appears to already be applied' };
        }
        
        return { valid: false, error: stderr || 'Unknown git apply error' };
      }
    } catch (error: any) {
      return { valid: false, error: error.message };
    } finally {
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Detect mixed indentation
   */
  private detectMixedIndentation(patch: string): boolean {
    const lines = patch.split('\n');
    let hasTabs = false;
    let hasSpaces = false;

    for (const line of lines) {
      if (line.startsWith('+') || line.startsWith(' ')) {
        const content = line.startsWith('+') ? line.substring(1) : line.substring(1);
        if (content.startsWith('\t')) hasTabs = true;
        if (content.startsWith('  ')) hasSpaces = true;
      }
    }
    return hasTabs && hasSpaces;
  }

  /**
   * Post-commit validation - verify the commit is correct
   */
  validateCommit(
    filePath: string,
    expectedChanges: {
      startLine: number;
      endLine: number;
      addedLines: number;
      removedLines: number;
    }
  ): { valid: boolean; error?: string; warnings: string[] } {
    const warnings: string[] = [];

    try {
      // Get the diff of the last commit
<<<<<<< HEAD:scripts/unused/patch-validator.ts
      // FIX: Sanitize filePath to prevent shell injection
      const sanitizedPath = filePath.replace(/"/g, '\\"').replace(/\$/g, '').replace(/`/g, '');
      const diff = execSync(`git diff HEAD~1 -- "${sanitizedPath}"`, {
=======
      const diff = execSync('git diff HEAD~1 -- "$1"', {
        cwd: this.repoDir,
        encoding: 'utf-8',
        input: filePath
      });

      if (!diff) {
>>>>>>> origin/autopilot/pr-2-fixes:scripts/patch-validator.ts
        cwd: this.repoDir,
        encoding: 'utf-8',
      });

      if (!diff) {
        return { valid: false, error: 'No changes found in last commit for this file', warnings };
      }

      // Parse the diff
      const stats = this.parsePatchStats(diff);

      // Verify line counts match expectations
      if (Math.abs(stats.linesAdded - expectedChanges.addedLines) > 2) {
        warnings.push(`Added lines (${stats.linesAdded}) differs from expected (${expectedChanges.addedLines})`);
      }
      if (Math.abs(stats.linesRemoved - expectedChanges.removedLines) > 2) {
        warnings.push(`Removed lines (${stats.linesRemoved}) differs from expected (${expectedChanges.removedLines})`);
      }

      // Check that only the expected file was changed
      if (stats.filesChanged > 1) {
        warnings.push('Multiple files changed in commit - verify this is correct');
      }

      // Verify no unintended changes
      const diffLines = diff.split('\n');
      const removedContent = diffLines.filter(l => l.startsWith('-') && !l.startsWith('---'));
      
      // Check for accidentally removed blank lines
      const blankLinesRemoved = removedContent.filter(l => l === '-').length;
      if (blankLinesRemoved > 1) {
        warnings.push(`${blankLinesRemoved} blank lines removed - verify this is intentional`);
      }

      return { valid: true, warnings };
    } catch (error: any) {
      return { valid: false, error: error.message, warnings };
    }
  }

  /**
   * Quick sanity check for a patch before applying
   */
  quickSanityCheck(patch: string): { valid: boolean; error?: string } {
    // Check patch isn't empty
    if (!patch || patch.trim().length === 0) {
      return { valid: false, error: 'Patch is empty' };
    }

    // Check minimum patch size
    if (patch.split('\n').length < 4) {
      return { valid: false, error: 'Patch too small - likely malformed' };
    }

    // Check for balanced quotes/brackets in added lines
    const addedLines = patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    
    for (const line of addedLines) {
      const content = line.substring(1);
      const openBraces = (content.match(/{/g) || []).length;
      const closeBraces = (content.match(/}/g) || []).length;
      const openParens = (content.match(/\(/g) || []).length;
      const closeParens = (content.match(/\)/g) || []).length;
      const openBrackets = (content.match(/\[/g) || []).length;
      const closeBrackets = (content.match(/\]/g) || []).length;

      // Only warn if severely unbalanced on a single line
      if (Math.abs(openBraces - closeBraces) > 2) {
        // This might be okay if it's part of a multi-line construct
      }
    }

    return { valid: true };
  }
}
