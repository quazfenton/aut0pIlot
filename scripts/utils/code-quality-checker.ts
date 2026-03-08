import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// parse-diff module (use require to avoid esModuleInterop issues)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const parse = require('parse-diff');

export interface CodeQualityReport {
  overall: {
    score: number; // 0-100
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
    passed: boolean;
  };
  checks: {
    syntax: SyntaxCheck;
    formatting: FormattingCheck;
    lint: LintCheck;
    complexity: ComplexityCheck;
    security: SecurityCheck;
  };
  issues: CodeIssue[];
  recommendations: string[];
}

export interface SyntaxCheck {
  passed: boolean;
  errors: string[];
  language: string;
}

export interface FormattingCheck {
  passed: boolean;
  tool: 'prettier' | 'eslint' | 'none';
  issues: string[];
}

export interface LintCheck {
  passed: boolean;
  tool: 'eslint' | 'tslint' | 'none';
  errors: number;
  warnings: number;
  messages: Array<{
    rule: string;
    message: string;
    line?: number;
    severity: 'error' | 'warning';
  }>;
}

export interface ComplexityCheck {
  passed: boolean;
  metrics: {
    linesChanged: number;
    filesChanged: number;
    avgLineLength: number;
    maxLineLength: number;
  };
  thresholds: {
    maxLinesPerPatch: number;
    maxLineLength: number;
    maxFilesPerPatch: number;
  };
}

export interface SecurityCheck {
  passed: boolean;
  issues: Array<{
    type: 'hardcoded_secret' | 'sql_injection' | 'xss' | 'path_traversal' | 'eval_usage';
    severity: 'critical' | 'high' | 'medium' | 'low';
    line?: number;
    file?: string;
    description: string;
  }>;
}

export interface CodeIssue {
  type: 'syntax' | 'formatting' | 'lint' | 'complexity' | 'security';
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

export interface QualityConfig {
  maxLinesPerPatch: number;
  maxLineLength: number;
  maxFilesPerPatch: number;
  requireFormatting: boolean;
  requireLint: boolean;
  securityScan: boolean;
  allowedRules?: string[]; // ESLint rules to ignore
}

const DEFAULT_CONFIG: QualityConfig = {
  maxLinesPerPatch: 500,
  maxLineLength: 120,
  maxFilesPerPatch: 10,
  requireFormatting: true,
  requireLint: false,
  securityScan: true,
  allowedRules: []
};

export class CodeQualityChecker {
  private config: QualityConfig;
  private tempDir: string;

  constructor(config: Partial<QualityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'quality-check-'));
  }

  /**
   * Check patch quality
   */
  async checkPatch(patch: string, baseDir?: string): Promise<CodeQualityReport> {
    const issues: CodeIssue[] = [];
    const recommendations: string[] = [];

    // Parse patch to extract files
    const files = this.parsePatch(patch);

    // Run all checks
    const syntaxCheck = await this.checkSyntax(files, baseDir);
    const formattingCheck = await this.checkFormatting(files, baseDir);
    const lintCheck = await this.checkLint(files, baseDir);
    const complexityCheck = this.checkComplexity(files, patch);
    const securityCheck = this.config.securityScan ? this.checkSecurity(files) : { passed: true, issues: [] };

    // Collect issues
    if (!syntaxCheck.passed) {
      for (const error of syntaxCheck.errors) {
        issues.push({
          type: 'syntax',
          severity: 'error',
          message: error
        });
      }
    }

    if (!formattingCheck.passed) {
      for (const issue of formattingCheck.issues) {
        issues.push({
          type: 'formatting',
          severity: 'warning',
          message: issue
        });
      }
    }

    if (!lintCheck.passed) {
      for (const msg of lintCheck.messages) {
        issues.push({
          type: 'lint',
          severity: msg.severity,
          message: `${msg.rule}: ${msg.message}`,
          line: msg.line
        });
      }
    }

    if (!complexityCheck.passed) {
      if (complexityCheck.metrics.linesChanged > this.config.maxLinesPerPatch) {
        issues.push({
          type: 'complexity',
          severity: 'warning',
          message: `Patch is too large (${complexityCheck.metrics.linesChanged} lines, max: ${this.config.maxLinesPerPatch})`
        });
      }

      if (complexityCheck.metrics.maxLineLength > this.config.maxLineLength) {
        issues.push({
          type: 'complexity',
          severity: 'warning',
          message: `Line too long (${complexityCheck.metrics.maxLineLength} chars, max: ${this.config.maxLineLength})`
        });
      }
    }

    if (!securityCheck.passed) {
      for (const issue of securityCheck.issues) {
        issues.push({
          type: 'security',
          severity: issue.severity === 'critical' || issue.severity === 'high' ? 'error' : 'warning',
          message: `[${issue.type}] ${issue.description}`,
          file: issue.file,
          line: issue.line
        });
      }
    }

    // Calculate overall score
    const score = this.calculateScore(issues, files.length);
    const grade = this.scoreToGrade(score);

    // Generate recommendations
    if (issues.length > 0) {
      recommendations.push(`Fix ${issues.filter(i => i.severity === 'error').length} error(s) before applying`);
    }

    if (securityCheck.issues.length > 0) {
      recommendations.push('Review security findings carefully');
    }

    if (complexityCheck.metrics.linesChanged > 100) {
      recommendations.push('Consider splitting this large patch into smaller, focused changes');
    }

    return {
      overall: {
        score,
        grade,
        passed: score >= 70 && issues.filter(i => i.severity === 'error').length === 0
      },
      checks: {
        syntax: syntaxCheck,
        formatting: formattingCheck,
        lint: lintCheck,
        complexity: complexityCheck,
        security: securityCheck
      },
      issues,
      recommendations
    };
  }

  /**
   * Parse patch and extract file contents using parse-diff library
   * This handles edge cases like file deletions, renames, and binary files
   */
  private parsePatch(patch: string): Array<{ file: string; content: string; changes: string[] }> {
    const files: Array<{ file: string; content: string; changes: string[] }> = [];

    try {
      // Use parse-diff library for robust patch parsing
      const parsedPatches = parse(patch);

      for (const parsedPatch of parsedPatches) {
        const fileName = parsedPatch.to || parsedPatch.from || 'unknown';

        // Extract changes (additions only for security/content analysis)
        const additions: string[] = [];
        const contentLines: string[] = [];

        if (parsedPatch.chunks) {
          for (const chunk of parsedPatch.chunks) {
            if (chunk.changes) {
              for (const change of chunk.changes) {
                if (change.content === undefined) {
                  continue;
                }
                const lineContent = change.content.substring(1);
                if (change.type === 'add') {
                  additions.push(lineContent);
                  contentLines.push(lineContent);
                } else if (change.type === 'normal') {
                  // Include context lines for content reconstruction
                  contentLines.push(lineContent);
                }
              }
            }
          }
        }

        // Skip files with no actual changes (e.g., binary files, metadata-only)
        if (additions.length === 0 && contentLines.length === 0) {
          continue;
        }

        files.push({
          file: fileName,
          content: contentLines.join('\n'),
          changes: additions
        });
      }
    } catch (error: any) {
      console.warn(`Failed to parse patch: ${error.message}`);
      // Fallback: return empty array if parsing fails
      return [];
    }

    return files;
  }

  /**
   * Check syntax validity
   */
  private async checkSyntax(
    files: Array<{ file: string; content: string }>,
    baseDir?: string
  ): Promise<SyntaxCheck> {
    const errors: string[] = [];
    let language = 'unknown';

    for (const { file, content } of files) {
      const ext = path.extname(file).toLowerCase();

      if (ext === '.ts' || ext === '.tsx') {
        language = 'typescript';
        try {
          // Use TypeScript compiler API for syntax check
          const ts = require('typescript') as typeof import('typescript');

          const result = ts.transpileModule(content, {
            compilerOptions: {
              target: ts.ScriptTarget.ES2020,
              module: ts.ModuleKind.CommonJS,
              syntaxCheckOnly: true
            }
          });

          if (result.diagnostics && result.diagnostics.length > 0) {
            for (const diag of result.diagnostics) {
              errors.push(`${file}: ${ts.flattenDiagnosticMessageText(diag.messageText, '\n')}`);
            }
          }
        } catch (error: any) {
          errors.push(`${file}: ${error.message}`);
        }
      } else if (ext === '.jsx') {
        language = 'javascript';
        // Skip Function-based validation for JSX - it cannot parse JSX syntax
        // JSX requires transpilation (Babel/TypeScript) before evaluation
        // We'll rely on linting and formatting checks instead
      } else if (ext === '.js') {
        language = 'javascript';
        try {
          // Basic JS syntax check
          new Function(content);
        } catch (error: any) {
          errors.push(`${file}: ${error.message}`);
        }
      } else if (ext === '.json') {
        language = 'json';
        try {
          JSON.parse(content);
        } catch (error: any) {
          errors.push(`${file}: ${error.message}`);
        }
      }
    }

    return {
      passed: errors.length === 0,
      errors,
      language
    };
  }

  /**
   * Check code formatting
   */
  private async checkFormatting(
    files: Array<{ file: string; content: string }>,
    baseDir?: string
  ): Promise<FormattingCheck> {
    const issues: string[] = [];

    if (!this.config.requireFormatting) {
      return { passed: true, tool: 'none', issues: [] };
    }

    // Try prettier if available
    try {
      const prettier = require('prettier') as typeof import('prettier');

      for (const { file, content } of files) {
        const ext = path.extname(file).toLowerCase();
        if (['.ts', '.tsx', '.js', '.jsx', '.json'].includes(ext)) {
          try {
            const formatted = await prettier.format(content, {
              filepath: file,
              parser: ext === '.json' ? 'json' : ext === '.ts' || ext === '.tsx' ? 'typescript' : 'babel'
            });

            if (formatted !== content) {
              issues.push(`${file}: Formatting differences detected`);
            }
          } catch {
            // Parser not available for this file type
          }
        }
      }

      return { passed: issues.length === 0, tool: 'prettier', issues };
    } catch {
      return { passed: true, tool: 'none', issues: [] };
    }
  }

  /**
   * Run linting checks
   */
  private async checkLint(
    files: Array<{ file: string; content: string }>,
    baseDir?: string
  ): Promise<LintCheck> {
    if (!this.config.requireLint) {
      return { passed: true, tool: 'none', errors: 0, warnings: 0, messages: [] };
    }

    const messages: LintCheck['messages'] = [];

    // Try ESLint if available
    try {
      const eslintPkg = require('eslint') as typeof import('eslint');
      const eslintVersion = require('eslint/package.json').version as string;
      const [major, minor] = eslintVersion.split('.').map(Number);
      const isModernEslint = major >= 9;

      let eslint: any;

      if (isModernEslint) {
        // ESLint v8.21.0+: useEslintrc was removed
        // Try to use flat config or fall back to recommended config
        try {
          eslint = new eslintPkg.ESLint({
            overrideConfigFile: baseDir ? path.join(baseDir, 'eslint.config.js') : undefined,
            ignore: false,
            useEslintrc: false
          });
        } catch {
          // Fallback: use recommended config without rc file
          eslint = new eslintPkg.ESLint({
            overrideConfig: { extends: ['eslint:recommended'] },
            ignore: false,
            useEslintrc: false
          });
        }
      } else {
        // ESLint < v8.21.0: useEslintrc is still available
        eslint = new eslintPkg.ESLint({
          useEslintrc: true,
          overrideConfigFile: baseDir ? path.join(baseDir, '.eslintrc.json') : undefined
        });
      }

      for (const { file, content } of files) {
        const ext = path.extname(file).toLowerCase();
        if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
          try {
            const results = await eslint.lintText(content, { filePath: file });

            for (const result of results) {
              for (const msg of result.messages) {
                if (!this.config.allowedRules?.includes(msg.ruleId)) {
                  messages.push({
                    rule: msg.ruleId || 'unknown',
                    message: msg.message,
                    line: msg.line,
                    severity: msg.severity === 2 ? 'error' : 'warning'
                  });
                }
              }
            }
          } catch (error: any) {
            // ESLint config or linting error - log but continue
            console.warn(`ESLint error for ${file}: ${error.message}`);
          }
        }
      }

      const errors = messages.filter(m => m.severity === 'error').length;
      const warnings = messages.filter(m => m.severity === 'warning').length;

      return {
        passed: errors === 0,
        tool: 'eslint',
        errors,
        warnings,
        messages
      };
    } catch (error: any) {
      console.warn(`ESLint not available: ${error.message}`);
      return { passed: true, tool: 'none', errors: 0, warnings: 0, messages: [] };
    }
  }

  /**
   * Check complexity metrics
   */
  private checkComplexity(
    files: Array<{ file: string; content: string; changes: string[] }>,
    patch: string
  ): ComplexityCheck {
    const totalLines = files.reduce((sum, f) => sum + f.changes.length, 0);
    const allLines = patch.split('\n');
    const lineLengths = allLines.map(l => l.length);

    return {
      passed:
        totalLines <= this.config.maxLinesPerPatch &&
        files.length <= this.config.maxFilesPerPatch &&
        Math.max(...lineLengths, 0) <= this.config.maxLineLength,
      metrics: {
        linesChanged: totalLines,
        filesChanged: files.length,
        avgLineLength: lineLengths.reduce((a, b) => a + b, 0) / Math.max(1, lineLengths.length),
        maxLineLength: Math.max(...lineLengths, 0)
      },
      thresholds: {
        maxLinesPerPatch: this.config.maxLinesPerPatch,
        maxLineLength: this.config.maxLineLength,
        maxFilesPerPatch: this.config.maxFilesPerPatch
      }
    };
  }

  /**
   * Check for security issues
   */
  private checkSecurity(files: Array<{ file: string; content: string; changes: string[] }>): SecurityCheck {
    const issues: SecurityCheck['issues'] = [];

    const securityPatterns = [
      {
        type: 'hardcoded_secret' as const,
        pattern: /(password|secret|api_key|apikey|token|credential)\s*[:=]\s*['"][^'"]{8,}['"]/i,
        severity: 'critical' as const,
        description: 'Potential hardcoded secret detected'
      },
      {
        type: 'sql_injection' as const,
        pattern: /(execute|query|select|insert|update|delete).*\$\{|\+.*\{/i,
        severity: 'high' as const,
        description: 'Potential SQL injection vulnerability'
      },
      {
        type: 'eval_usage' as const,
        pattern: /\b(eval|Function|setTimeout|setInterval)\s*\(/i,
        severity: 'high' as const,
        description: 'Use of eval() or similar dangerous function'
      },
      {
        type: 'path_traversal' as const,
        pattern: /\.\.[\\/]/,
        severity: 'medium' as const,
        description: 'Potential path traversal vulnerability'
      },
      {
        type: 'xss' as const,
        pattern: /innerHTML\s*=|document\.write\s*\(/i,
        severity: 'high' as const,
        description: 'Potential XSS vulnerability'
      }
    ];

    for (const { file, content, changes } of files) {
      // Only scan the changed lines (additions) for security issues
      // Scanning full content + changes would duplicate lines and produce false positives
      const linesToScan = changes.length > 0 ? changes : content.split('\n');

      for (const { type, pattern, severity, description } of securityPatterns) {
        for (let i = 0; i < linesToScan.length; i++) {
          // Reset lastIndex for global regexes to avoid state issues
          if (pattern.global) {
            pattern.lastIndex = 0;
          }
          if (pattern.test(linesToScan[i])) {
            issues.push({
              type,
              severity,
              line: i + 1,
              file,
              description
            });
          }
        }
      }
    }

    return {
      passed: issues.filter(i => i.severity === 'critical' || i.severity === 'high').length === 0,
      issues
    };
  }

  /**
   * Calculate overall quality score
   */
  private calculateScore(issues: CodeIssue[], fileCount: number): number {
    let score = 100;

    // Deduct for errors
    const errors = issues.filter(i => i.severity === 'error');
    const warnings = issues.filter(i => i.severity === 'warning');

    score -= errors.length * 15; // -15 per error
    score -= warnings.length * 5; // -5 per warning

    // Bonus for small, focused patches
    if (fileCount === 1) {
      score += 5;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Convert score to letter grade
   */
  private scoreToGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
  }

  /**
   * Cleanup temp files
   */
  cleanup(): void {
    try {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Create code quality checker instance
 */
export function createCodeQualityChecker(config?: Partial<QualityConfig>): CodeQualityChecker {
  return new CodeQualityChecker(config);
}
