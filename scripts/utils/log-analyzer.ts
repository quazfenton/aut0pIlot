import * as fs from 'fs';
import * as path from 'path';

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug' | 'success';
  category: string;
  message: string;
  data?: any;
  sessionId?: string;
  repo?: string;
  pr?: number;
}

export interface LogAnalysis {
  summary: {
    totalEntries: number;
    byLevel: Record<string, number>;
    byCategory: Record<string, number>;
    errorRate: number;
    timeRange: {
      start: string;
      end: string;
      duration: number;
    };
  };
  errors: Array<{
    timestamp: string;
    category: string;
    message: string;
    context?: string;
  }>;
  warnings: Array<{
    timestamp: string;
    category: string;
    message: string;
  }>;
  patterns: {
    recurringErrors: Array<{ pattern: string; count: number }>;
    peakErrorTimes: Array<{ hour: number; count: number }>;
    slowOperations: Array<{ operation: string; avgDuration: number }>;
  };
  recommendations: string[];
}

export interface SessionMetrics {
  sessionId: string;
  startTime: string;
  endTime: string;
  totalPatches: number;
  successfulPatches: number;
  failedPatches: number;
  avgPatchTime: number;
  errors: number;
  warnings: number;
  qualityScore: number;
}

export class LogAnalyzer {
  private logDir: string;

  constructor(logDir: string = './logs/pr-autopilot') {
    this.logDir = logDir;
  }

  /**
   * Parse log file and return entries
   */
  parseLogFile(filePath: string): LogEntry[] {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    const entries: LogEntry[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        entries.push(entry as LogEntry);
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  }

  /**
   * Analyze logs and generate comprehensive report
   */
  analyzeLogs(sessionId?: string): LogAnalysis {
    const logFile = path.join(this.logDir, `session-${sessionId || 'global'}.jsonl`);
    const entries = this.parseLogFile(logFile);

    if (entries.length === 0) {
      return this.createEmptyAnalysis();
    }

    const byLevel: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    const errors: LogAnalysis['errors'] = [];
    const warnings: LogAnalysis['warnings'] = [];
    const errorPatterns = new Map<string, number>();
    const errorHours = new Map<number, number>();

    let timestamps: Date[] = [];

    for (const entry of entries) {
      // Count by level
      byLevel[entry.level] = (byLevel[entry.level] || 0) + 1;

      // Count by category
      byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;

      // Track timestamps
      if (entry.timestamp) {
        timestamps.push(new Date(entry.timestamp));
      }

      // Collect errors
      if (entry.level === 'error') {
        errors.push({
          timestamp: entry.timestamp,
          category: entry.category,
          message: entry.message,
          context: entry.data?.error || entry.data?.details
        });

        // Track error patterns
        const pattern = this.extractErrorPattern(entry.message);
        errorPatterns.set(pattern, (errorPatterns.get(pattern) || 0) + 1);

        // Track error hours
        if (entry.timestamp) {
          const hour = new Date(entry.timestamp).getHours();
          errorHours.set(hour, (errorHours.get(hour) || 0) + 1);
        }
      }

      // Collect warnings
      if (entry.level === 'warn') {
        warnings.push({
          timestamp: entry.timestamp,
          category: entry.category,
          message: entry.message
        });
      }
    }

    // Calculate time range
    timestamps.sort((a, b) => a.getTime() - b.getTime());
    const startTime = timestamps[0];
    const endTime = timestamps[timestamps.length - 1];
    const duration = endTime.getTime() - startTime.getTime();

    // Calculate error rate
    const errorRate = entries.length > 0 ? (byLevel['error'] || 0) / entries.length : 0;

    // Find recurring error patterns
    const recurringErrors = Array.from(errorPatterns.entries())
      .filter(([_, count]) => count >= 2)
      .map(([pattern, count]) => ({ pattern, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Find peak error times
    const peakErrorTimes = Array.from(errorHours.entries())
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Generate recommendations
    const recommendations = this.generateRecommendations({
      errorRate,
      errors,
      warnings,
      recurringErrors,
      byLevel,
      byCategory
    });

    return {
      summary: {
        totalEntries: entries.length,
        byLevel,
        byCategory,
        errorRate,
        timeRange: {
          start: startTime.toISOString(),
          end: endTime.toISOString(),
          duration
        }
      },
      errors,
      warnings,
      patterns: {
        recurringErrors,
        peakErrorTimes,
        slowOperations: [] // Would need timing data
      },
      recommendations
    };
  }

  /**
   * Extract error pattern from message
   */
  private extractErrorPattern(message: string): string {
    // Normalize error messages to find patterns
    return message
      .replace(/\d+/g, 'N') // Replace numbers
      .replace(/0x[a-f0-9]+/gi, 'ADDR') // Replace hex addresses
      .replace(/\/[^\s]+/g, 'PATH') // Replace paths
      .substring(0, 100); // Limit length
  }

  /**
   * Generate recommendations based on analysis
   */
  private generateRecommendations(data: {
    errorRate: number;
    errors: LogAnalysis['errors'];
    warnings: LogAnalysis['warnings'];
    recurringErrors: Array<{ pattern: string; count: number }>;
    byLevel: Record<string, number>;
    byCategory: Record<string, number>;
  }): string[] {
    const recommendations: string[] = [];

    // High error rate
    if (data.errorRate > 0.1) {
      recommendations.push(
        `⚠️ High error rate detected (${(data.errorRate * 100).toFixed(1)}%). Review error handling.`
      );
    }

    // Recurring errors
    if (data.recurringErrors.length > 0) {
      const topError = data.recurringErrors[0];
      recommendations.push(
        `🔄 Recurring error detected (${topError.count}x): "${topError.pattern.substring(0, 50)}..."`
      );
    }

    // Many warnings
    if (data.warnings.length > data.errors.length * 2) {
      recommendations.push(
        `📊 High warning count (${data.warnings.length}). Consider addressing warnings before they become errors.`
      );
    }

    // Category-specific issues
    const patchGenErrors = data.errors.filter(e => e.category.includes('PATCH')).length;
    if (patchGenErrors > 5) {
      recommendations.push(
        `🔧 Multiple patch generation errors (${patchGenErrors}). Review patch generation logic.`
      );
    }

    const gitErrors = data.errors.filter(e => e.message.toLowerCase().includes('git')).length;
    if (gitErrors > 3) {
      recommendations.push(
        `📦 Git operation errors detected (${gitErrors}). Check git configuration and repository access.`
      );
    }

    if (recommendations.length === 0) {
      recommendations.push('✅ No critical issues detected. System is healthy.');
    }

    return recommendations;
  }

  /**
   * Create empty analysis result
   */
  private createEmptyAnalysis(): LogAnalysis {
    return {
      summary: {
        totalEntries: 0,
        byLevel: {},
        byCategory: {},
        errorRate: 0,
        timeRange: {
          start: '',
          end: '',
          duration: 0
        }
      },
      errors: [],
      warnings: [],
      patterns: {
        recurringErrors: [],
        peakErrorTimes: [],
        slowOperations: []
      },
      recommendations: ['No log data available for analysis.']
    };
  }

  /**
   * Calculate session metrics
   */
  calculateSessionMetrics(sessionId: string): SessionMetrics {
    const analysis = this.analyzeLogs(sessionId);

    // Count patch-related entries
    const patchEntries = Object.entries(analysis.summary.byCategory)
      .filter(([cat]) => cat.includes('PATCH'))
      .reduce((sum, [_, count]) => sum + count, 0);

    // Estimate success/failure from error count
    // Use case-insensitive matching to catch all variations (PATCH, Patch, patch)
    const failedPatches = analysis.errors.filter(e =>
      e.category.toUpperCase().includes('PATCH') || e.message.toLowerCase().includes('patch')
    ).length;

    const successfulPatches = Math.max(0, patchEntries - failedPatches);

    // Calculate quality score (0-100)
    let qualityScore = 100;
    qualityScore -= analysis.summary.errorRate * 50; // Up to -50 for errors
    qualityScore -= Math.min(20, failedPatches * 2); // Up to -20 for failures
    qualityScore -= Math.min(10, analysis.warnings.length); // Up to -10 for warnings
    qualityScore = Math.max(0, Math.round(qualityScore));

    return {
      sessionId,
      startTime: analysis.summary.timeRange.start,
      endTime: analysis.summary.timeRange.end,
      totalPatches: patchEntries,
      successfulPatches: successfulPatches,
      failedPatches,
      avgPatchTime: analysis.summary.timeRange.duration / Math.max(1, patchEntries),
      errors: analysis.summary.byLevel['error'] || 0,
      warnings: analysis.summary.byLevel['warn'] || 0,
      qualityScore
    };
  }

  /**
   * Export analysis to file
   */
  exportAnalysis(analysis: LogAnalysis, outputPath: string): void {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(analysis, null, 2));
  }

  /**
   * Generate human-readable report
   */
  generateReport(analysis: LogAnalysis): string {
    const lines: string[] = [];

    lines.push('╔══════════════════════════════════════════════════════════════╗');
    lines.push('║           PR AUTOPILOT LOG ANALYSIS REPORT                  ║');
    lines.push('╚══════════════════════════════════════════════════════════════╝');
    lines.push('');

    // Summary
    lines.push('📊 SUMMARY');
    lines.push('─'.repeat(60));
    lines.push(`Total Entries: ${analysis.summary.totalEntries}`);
    lines.push(`Error Rate: ${(analysis.summary.errorRate * 100).toFixed(2)}%`);
    lines.push(`Time Range: ${analysis.summary.timeRange.start} to ${analysis.summary.timeRange.end}`);
    lines.push(`Duration: ${(analysis.summary.timeRange.duration / 1000).toFixed(2)}s`);
    lines.push('');

    // By Level
    lines.push('📈 BY LEVEL');
    lines.push('─'.repeat(60));
    for (const [level, count] of Object.entries(analysis.summary.byLevel)) {
      const bar = '█'.repeat(Math.min(50, Math.round((count / analysis.summary.totalEntries) * 50)));
      lines.push(`${level.padEnd(10)} ${count.toString().padStart(5)} ${bar}`);
    }
    lines.push('');

    // Errors
    if (analysis.errors.length > 0) {
      lines.push('❌ ERRORS');
      lines.push('─'.repeat(60));
      for (const error of analysis.errors.slice(0, 10)) {
        lines.push(`[${error.timestamp}] ${error.category}: ${error.message}`);
        if (error.context) {
          lines.push(`  Context: ${error.context}`);
        }
      }
      if (analysis.errors.length > 10) {
        lines.push(`  ... and ${analysis.errors.length - 10} more errors`);
      }
      lines.push('');
    }

    // Recurring Patterns
    if (analysis.patterns.recurringErrors.length > 0) {
      lines.push('🔄 RECURRING ERROR PATTERNS');
      lines.push('─'.repeat(60));
      for (const { pattern, count } of analysis.patterns.recurringErrors) {
        lines.push(`  ${count}x: ${pattern}`);
      }
      lines.push('');
    }

    // Recommendations
    lines.push('💡 RECOMMENDATIONS');
    lines.push('─'.repeat(60));
    for (const rec of analysis.recommendations) {
      lines.push(rec);
    }
    lines.push('');

    return lines.join('\n');
  }
}

/**
 * Create log analyzer instance
 */
export function createLogAnalyzer(logDir?: string): LogAnalyzer {
  return new LogAnalyzer(logDir);
}
