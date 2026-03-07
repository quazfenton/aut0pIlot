import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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
   * Parse patch and extract file contents
   */
  private parsePatch(patch: string): Array<{ file: string; content: string; changes: string[] }> {
    const files: Array<{ file: string; content: string; changes: string[] }> = [];
    const lines = patch.split('\n');

    let currentFile = '';
    let currentContent: string[] = [];
    let changes: string[] = [];

    for (const line of lines) {
      if (line.startsWith('+++ b/')) {
        // Save previous file
        if (currentFile) {
          files.push({
            file: currentFile,
            content: currentContent.join('\n'),
            changes: [...changes]
          });
        }

        // Start new file
        currentFile = line.substring(6);
        currentContent = [];
        changes = [];
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        changes.push(line);
        currentContent.push(line.substring(1));
      } else if (line.startsWith(' ') || line.startsWith('-')) {
        if (!line.startsWith('-')) {
          currentContent.push(line.substring(1));
        }
      }
    }

    // Save last file
    if (currentFile) {
      files.push({
        file: currentFile,
        content: currentContent.join('\n'),
        changes
      });
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
      } else if (ext === '.js' || ext === '.jsx') {
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
      const { ESLint } = require('eslint') as typeof import('eslint');
      const eslint = new ESLint({
        useEslintrc: true,
        overrideConfigFile: baseDir ? path.join(baseDir, '.eslintrc.json') : undefined
      });

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
          } catch {
            // ESLint config issue
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
    } catch {
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
        pattern: /(password|secret|api_key|apikey|token|credential)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
        severity: 'critical' as const,
        description: 'Potential hardcoded secret detected'
      },
      {
        type: 'sql_injection' as const,
        pattern: /(execute|query|select|insert|update|delete).*\$\{|\+.*\{/gi,
        severity: 'high' as const,
        description: 'Potential SQL injection vulnerability'
      },
      {
        type: 'eval_usage' as const,
        pattern: /\b(eval|Function|setTimeout|setInterval)\s*\(/gi,
        severity: 'high' as const,
        description: 'Use of eval() or similar dangerous function'
      },
      {
        type: 'path_traversal' as const,
        pattern: /\.\.[\\/]/g,
        severity: 'medium' as const,
        description: 'Potential path traversal vulnerability'
      },
      {
        type: 'xss' as const,
        pattern: /innerHTML\s*=|document\.write\s*\(/gi,
        severity: 'high' as const,
        description: 'Potential XSS vulnerability'
      }
    ];

    for (const { file, content, changes } of files) {
      const allContent = content + '\n' + changes.join('\n');
      const lines = allContent.split('\n');

      for (const { type, pattern, severity, description } of securityPatterns) {
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
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
