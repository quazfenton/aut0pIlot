import { DiffUtils } from './diff-utils';
import { CodeQualityChecker, CodeQualityReport } from './code-quality-checker';

export interface PatchMetrics {
  // Basic metrics
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  hunksCount: number;

  // Quality metrics
  syntaxValid: boolean;
  formattingValid: boolean;
  lintPassed: boolean;
  securityPassed: boolean;

  // Complexity metrics
  avgHunkSize: number;
  maxHunkSize: number;
  largestFile: string;
  largestFileChanges: number;

  // Risk assessment
  riskScore: number; // 0-100
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskFactors: string[];

  // Quality score
  qualityScore: number; // 0-100
  qualityGrade: 'A' | 'B' | 'C' | 'D' | 'F';
}

export interface PatchReport {
  metrics: PatchMetrics;
  qualityReport: CodeQualityReport;
  summary: string;
  recommendations: string[];
  timestamp: string;
}

interface MetricsWithQuality {
  metrics: PatchMetrics;
  qualityReport: CodeQualityReport;
}

export class PatchMetricsCalculator {
  private qualityChecker: CodeQualityChecker;

  constructor() {
    this.qualityChecker = new CodeQualityChecker();
  }

  /**
   * Calculate comprehensive metrics for a patch
   */
  async calculateMetrics(patch: string): Promise<PatchMetrics> {
    const result = await this.calculateMetricsWithQuality(patch);
    return result.metrics;
  }

  /**
   * Calculate metrics and return quality report together (avoids duplicate work)
   */
  private async calculateMetricsWithQuality(patch: string): Promise<MetricsWithQuality> {
    // Basic diff analysis
    const diffValidation = DiffUtils.validateDiff(patch);
    const changes = DiffUtils.extractChanges(patch);

    // Code quality check (called ONCE and reused)
    const qualityReport = await this.qualityChecker.checkPatch(patch);

    // Calculate metrics
    const linesAdded = changes.added.length;
    const linesRemoved = changes.removed.length;
    const filesChanged = diffValidation.stats.filesChanged;
    const hunksCount = diffValidation.stats.hunksCount;

    // Calculate hunk sizes
    const hunkSizes = this.calculateHunkSizes(patch);
    const avgHunkSize = hunkSizes.reduce((a, b) => a + b, 0) / Math.max(1, hunkSizes.length);
    const maxHunkSize = Math.max(...hunkSizes, 0);

    // Find largest file
    const fileChanges = this.getFileChanges(patch);
    const largestFileEntry = fileChanges.reduce((max, current) =>
      current.changes > max.changes ? current : max
    , { file: '', changes: 0 });

    // Risk assessment
    const riskScore = this.calculateRiskScore({
      linesAdded,
      linesRemoved,
      filesChanged,
      hunksCount,
      maxHunkSize,
      qualityReport
    });

    const riskLevel = this.scoreToRiskLevel(riskScore);
    const riskFactors = this.identifyRiskFactors({
      linesAdded,
      filesChanged,
      maxHunkSize,
      qualityReport
    });

    // Quality score
    const qualityScore = qualityReport.overall.score;
    const qualityGrade = qualityReport.overall.grade;

    return {
      linesAdded,
      linesRemoved,
      filesChanged,
      hunksCount,
      syntaxValid: qualityReport.checks.syntax.passed,
      formattingValid: qualityReport.checks.formatting.passed,
      lintPassed: qualityReport.checks.lint.passed,
      securityPassed: qualityReport.checks.security.passed,
      avgHunkSize: Math.round(avgHunkSize * 100) / 100,
      maxHunkSize,
      largestFile: largestFileEntry.file,
      largestFileChanges: largestFileEntry.changes,
      riskScore,
      riskLevel,
      riskFactors,
      qualityScore,
      qualityGrade
    };

    return {
      metrics,
      qualityReport
    };
  }

  /**
   * Generate comprehensive patch report
   */
  async generateReport(patch: string, context?: {
    repo?: string;
    pr?: number;
    file?: string;
    author?: string;
  }): Promise<PatchReport> {
    // Reuse qualityReport from calculateMetricsWithQuality to avoid duplicate checkPatch() call
    const result = await this.calculateMetricsWithQuality(patch);
    const metrics = result.metrics;
    const qualityReport = result.qualityReport;

    const summary = this.generateSummary(metrics, context);
    const recommendations = this.generateRecommendations(metrics, qualityReport);

    return {
      metrics,
      qualityReport,
      summary,
      recommendations,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Calculate hunk sizes from patch
   */
  private calculateHunkSizes(patch: string): number[] {
    const hunkSizes: number[] = [];
    const lines = patch.split('\n');

    let currentHunkSize = 0;
    let inHunk = false;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        if (inHunk && currentHunkSize > 0) {
          hunkSizes.push(currentHunkSize);
        }
        inHunk = true;
        currentHunkSize = 0;
      } else if (inHunk && (line.startsWith('+') || line.startsWith('-'))) {
        currentHunkSize++;
      }
    }

    // Don't forget the last hunk
    if (inHunk && currentHunkSize > 0) {
      hunkSizes.push(currentHunkSize);
    }

    return hunkSizes;
  }

  /**
   * Get changes per file
   */
  private getFileChanges(patch: string): Array<{ file: string; changes: number }> {
    const fileChanges: Array<{ file: string; changes: number }> = [];
    const lines = patch.split('\n');

    let currentFile = '';
    let currentChanges = 0;

    for (const line of lines) {
      if (line.startsWith('+++ b/')) {
        if (currentFile && currentChanges > 0) {
          fileChanges.push({ file: currentFile, changes: currentChanges });
        }
        currentFile = line.substring(6);
        currentChanges = 0;
      } else if (line.startsWith('--- a/') || line.startsWith('@@')) {
        // Skip diff header lines and hunk headers - they're not code changes
        continue;
      } else if (line.startsWith('+') || line.startsWith('-')) {
        // Only count actual code additions/deletions, not diff metadata
        currentChanges++;
      }
    }

    // Don't forget the last file
    if (currentFile && currentChanges > 0) {
      fileChanges.push({ file: currentFile, changes: currentChanges });
    }

    return fileChanges;
  }

  /**
   * Calculate risk score (0-100)
   */
  private calculateRiskScore(data: {
    linesAdded: number;
    linesRemoved: number;
    filesChanged: number;
    hunksCount: number;
    maxHunkSize: number;
    qualityReport: CodeQualityReport;
  }): number {
    let score = 0;

    // Size factors (0-30 points)
    if (data.linesAdded > 500) score += 15;
    else if (data.linesAdded > 100) score += 10;
    else if (data.linesAdded > 50) score += 5;

    if (data.filesChanged > 10) score += 10;
    else if (data.filesChanged > 5) score += 5;

    if (data.maxHunkSize > 100) score += 5;

    // Quality factors (0-50 points)
    if (!data.qualityReport.checks.syntax.passed) score += 25;
    if (!data.qualityReport.checks.security.passed) score += 25;
    if (!data.qualityReport.checks.lint.passed) score += 10;
    if (!data.qualityReport.checks.formatting.passed) score += 5;

    // Security issues (0-20 points)
    const criticalSecurityIssues = data.qualityReport.checks.security.issues
      .filter(i => i.severity === 'critical' || i.severity === 'high').length;
    score += criticalSecurityIssues * 10;

    return Math.min(100, score);
  }

  /**
   * Convert risk score to risk level
   */
  private scoreToRiskLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
    if (score >= 75) return 'critical';
    if (score >= 50) return 'high';
    if (score >= 25) return 'medium';
    return 'low';
  }

  /**
   * Identify specific risk factors
   */
  private identifyRiskFactors(data: {
    linesAdded: number;
    filesChanged: number;
    maxHunkSize: number;
    qualityReport: CodeQualityReport;
  }): string[] {
    const factors: string[] = [];

    if (data.linesAdded > 500) {
      factors.push('Large patch (>500 lines added)');
    }

    if (data.filesChanged > 10) {
      factors.push('Many files changed (>10 files)');
    }

    if (data.maxHunkSize > 100) {
      factors.push('Large hunk (>100 lines)');
    }

    if (!data.qualityReport.checks.syntax.passed) {
      factors.push('Syntax errors detected');
    }

    if (!data.qualityReport.checks.security.passed) {
      const securityIssues = data.qualityReport.checks.security.issues;
      if (securityIssues.some(i => i.severity === 'critical')) {
        factors.push('Critical security issues');
      }
      if (securityIssues.some(i => i.severity === 'high')) {
        factors.push('High severity security issues');
      }
    }

    if (data.qualityReport.checks.lint.errors > 5) {
      factors.push('Multiple lint errors');
    }

    return factors;
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(metrics: PatchMetrics, context?: {
    repo?: string;
    pr?: number;
    file?: string;
    author?: string;
  }): string {
    const parts: string[] = [];

    // Context
    if (context?.repo && context?.pr) {
      parts.push(`Patch for ${context.repo}#${context.pr}`);
    }

    // Basic stats
    parts.push(`${metrics.filesChanged} file(s), +${metrics.linesAdded}/-${metrics.linesRemoved} lines`);

    // Quality
    parts.push(`Quality: ${metrics.qualityGrade} (${metrics.qualityScore}/100)`);

    // Risk
    parts.push(`Risk: ${metrics.riskLevel.toUpperCase()} (${metrics.riskScore}/100)`);

    // Security
    if (!metrics.securityPassed) {
      parts.push('⚠️ Security issues detected');
    }

    return parts.join(' | ');
  }

  /**
   * Generate actionable recommendations
   */
  private generateRecommendations(metrics: PatchMetrics, qualityReport: CodeQualityReport): string[] {
    const recommendations: string[] = [];

    // Quality recommendations
    if (metrics.qualityScore < 70) {
      recommendations.push('Improve code quality before applying (current score: ' + metrics.qualityScore + ')');
    }

    if (!metrics.syntaxValid) {
      recommendations.push('Fix syntax errors before applying');
    }

    if (!metrics.formattingValid && qualityReport.checks.formatting.issues.length > 0) {
      recommendations.push('Run code formatter (prettier) to fix formatting issues');
    }

    if (!metrics.lintPassed) {
      recommendations.push('Address lint errors and warnings');
    }

    // Risk recommendations
    if (metrics.riskLevel === 'critical') {
      recommendations.push('⚠️ CRITICAL: Manual review required before applying');
    } else if (metrics.riskLevel === 'high') {
      recommendations.push('⚠️ HIGH RISK: Careful review recommended');
    }

    if (metrics.filesChanged > 10) {
      recommendations.push('Consider splitting into smaller, focused patches');
    }

    if (metrics.linesAdded > 500) {
      recommendations.push('Large patch - consider breaking into smaller PRs');
    }

    // Security recommendations
    if (!metrics.securityPassed) {
      const securityIssues = qualityReport.checks.security.issues;
      if (securityIssues.some(i => i.severity === 'critical')) {
        recommendations.push('🔒 CRITICAL: Address critical security issues immediately');
      }
      recommendations.push('Review security findings before applying');
    }

    if (recommendations.length === 0) {
      recommendations.push('✅ Patch looks good! Ready to apply.');
    }

    return recommendations;
  }

  /**
   * Export report to markdown format
   */
  exportToMarkdown(report: PatchReport): string {
    const lines: string[] = [];

    lines.push('# Patch Quality Report');
    lines.push('');
    lines.push(`Generated: ${report.timestamp}`);
    lines.push('');

    // Summary
    lines.push('## Summary');
    lines.push('');
    lines.push(report.summary);
    lines.push('');

    // Metrics table
    lines.push('## Metrics');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Files Changed | ${report.metrics.filesChanged} |`);
    lines.push(`| Lines Added | ${report.metrics.linesAdded} |`);
    lines.push(`| Lines Removed | ${report.metrics.linesRemoved} |`);
    lines.push(`| Hunks | ${report.metrics.hunksCount} |`);
    lines.push(`| Avg Hunk Size | ${report.metrics.avgHunkSize} |`);
    lines.push(`| Max Hunk Size | ${report.metrics.maxHunkSize} |`);
    lines.push('');

    // Quality scores
    lines.push('## Quality Scores');
    lines.push('');
    lines.push(`- **Overall Grade**: ${report.metrics.qualityGrade} (${report.metrics.qualityScore}/100)`);
    lines.push(`- **Syntax**: ${report.metrics.syntaxValid ? '✅' : '❌'}`);
    lines.push(`- **Formatting**: ${report.metrics.formattingValid ? '✅' : '❌'}`);
    lines.push(`- **Lint**: ${report.metrics.lintPassed ? '✅' : '❌'}`);
    lines.push(`- **Security**: ${report.metrics.securityPassed ? '✅' : '❌'}`);
    lines.push('');

    // Risk assessment
    lines.push('## Risk Assessment');
    lines.push('');
    lines.push(`**Risk Level**: ${report.metrics.riskLevel.toUpperCase()} (${report.metrics.riskScore}/100)`);
    lines.push('');

    if (report.metrics.riskFactors.length > 0) {
      lines.push('**Risk Factors**:');
      for (const factor of report.metrics.riskFactors) {
        lines.push(`- ${factor}`);
      }
      lines.push('');
    }

    // Recommendations
    lines.push('## Recommendations');
    lines.push('');
    for (const rec of report.recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push('');

    return lines.join('\n');
  }
}

/**
 * Create patch metrics calculator instance
 */
export function createPatchMetricsCalculator(): PatchMetricsCalculator {
  return new PatchMetricsCalculator();
}
