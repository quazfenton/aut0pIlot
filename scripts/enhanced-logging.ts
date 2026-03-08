import * as fs from 'fs';
import * as path from 'path';

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug' | 'success' | 'thinking';
  category: string;
  message: string;
  data?: any;
  sessionId?: string;
  prNumber?: number;
  repo?: string;
}

export interface ThinkingLog {
  id: string;
  sessionId: string;
  round: number;
  content: string;
  timestamp: string;
  context?: {
    file?: string;
    startLine?: number;
    endLine?: number;
    reviewComment?: string;
  };
}

export interface EnhancedLoggerOptions {
  logDir?: string;
  sessionId?: string;
  captureThinking?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  saveToFile?: boolean;
}

export class EnhancedLogger {
  private logDir: string;
  private sessionId: string;
  private captureThinking: boolean;
  private logLevel: string;
  private saveToFile: boolean;
  private logs: LogEntry[] = [];
  private thinkingLogs: ThinkingLog[] = [];
  private currentRound: number = 0;

  constructor(private options: EnhancedLoggerOptions = {}) {
    this.logDir = options.logDir || './logs/pr-autopilot';
    this.sessionId = options.sessionId || `session-${Date.now()}`;
    this.captureThinking = options.captureThinking ?? true;
    this.logLevel = options.logLevel || 'info';
    this.saveToFile = options.saveToFile ?? true;

    // Ensure log directory exists
    if (this.saveToFile) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Log an info message
   */
  info(category: string, message: string, data?: any): void {
    this.log('info', category, message, data);
  }

  /**
   * Log a warning message
   */
  warn(category: string, message: string, data?: any): void {
    this.log('warn', category, message, data);
  }

  /**
   * Log an error message
   */
  error(category: string, message: string, data?: any): void {
    this.log('error', category, message, data);
  }

  /**
   * Log a debug message
   */
  debug(category: string, message: string, data?: any): void {
    this.log('debug', category, message, data);
  }

  /**
   * Log a success message
   */
  success(category: string, message: string, data?: any): void {
    this.log('success', category, message, data);
  }

  /**
   * Capture thinking output from LLM
   */
  thinking(content: string, context?: ThinkingLog['context']): void {
    if (!this.captureThinking) return;

    const thinkingLog: ThinkingLog = {
      id: `thinking-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      sessionId: this.sessionId,
      round: ++this.currentRound,
      content,
      timestamp: new Date().toISOString(),
      context
    };

    this.thinkingLogs.push(thinkingLog);

    // Log to console with special formatting
    console.log(`\x1b[38;5;213m[THINKING]\x1b[0m Round ${thinkingLog.round}: ${content.substring(0, 200)}...`);

    // Save to file
    if (this.saveToFile) {
      this.saveThinkingLog(thinkingLog);
    }

    // Also log as regular entry
    this.log('thinking', 'LLM', 'Thinking output captured', { content, context });
  }

  /**
   * Log a patch generation attempt
   */
  logPatchAttempt(
    repo: string,
    pr: number,
    file: string,
    attempt: number,
    method: string,
    success: boolean,
    error?: string,
    patch?: string
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: success ? 'success' : 'error',
      category: 'PATCH_ATTEMPT',
      message: `Patch ${success ? 'succeeded' : 'failed'} (${method})`,
      data: {
        repo,
        pr,
        file,
        attempt,
        method,
        error,
        patchLength: patch?.length
      },
      sessionId: this.sessionId
    };

    this.logs.push(entry);

    // FIX: Respect saveToFile setting
    if (this.saveToFile) {
      this.saveLog(entry);
    }

    // Console output with colors
    const color = success ? '\x1b[32m' : '\x1b[31m';
    console.log(`${color}[PATCH]\x1b[0m ${repo}#${pr}:${file} - ${success ? 'succeeded' : 'failed'} (Attempt ${attempt})`);
  }

  /**
   * Log a validation error with diff highlight
   */
  logValidationError(
    repo: string,
    pr: number,
    file: string,
    patch: string,
    error: string,
    visualDiff?: string
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'error',
      category: 'VALIDATION_ERROR',
      message: `Patch validation failed for ${file}`,
      data: {
        repo,
        pr,
        file,
        error,
        patchLength: patch.length,
        visualDiff
      },
      sessionId: this.sessionId
    };

    this.logs.push(entry);

    // FIX: Respect saveToFile setting
    if (this.saveToFile) {
      this.saveLog(entry);
    }

    // Console output
    console.log(`\x1b[31m[VALIDATION ERROR]\x1b[0m ${repo}#${pr}:${file}`);
    if (visualDiff) {
      console.log(visualDiff);
    }
  }

  /**
   * Get all thinking logs for a session
   */
  getThinkingLogs(): ThinkingLog[] {
    return this.thinkingLogs;
  }

  /**
   * Get all logs for a session
   */
  getLogs(): LogEntry[] {
    return this.logs;
  }

  /**
   * Export session report
   */
  exportSessionReport(): string {
    const report: string[] = [];

    report.push(`# PR Autopilot Session Report`);
    report.push(`Session ID: ${this.sessionId}`);
    report.push(`Generated: ${new Date().toISOString()}`);
    report.push('');

    // Summary
    const summary = {
      totalLogs: this.logs.length,
      totalThinking: this.thinkingLogs.length,
      errors: this.logs.filter(l => l.level === 'error').length,
      warnings: this.logs.filter(l => l.level === 'warn').length,
      successes: this.logs.filter(l => l.level === 'success').length
    };

    report.push(`## Summary`);
    report.push(`- Total log entries: ${summary.totalLogs}`);
    report.push(`- Thinking outputs: ${summary.totalThinking}`);
    report.push(`- Errors: ${summary.errors}`);
    report.push(`- Warnings: ${summary.warnings}`);
    report.push(`- Successes: ${summary.successes}`);
    report.push('');

    // Patch attempts
    const patchAttempts = this.logs.filter(l => l.category === 'PATCH_ATTEMPT');
    if (patchAttempts.length > 0) {
      report.push(`## Patch Attempts`);
      for (const attempt of patchAttempts) {
        report.push(`- ${attempt.data.repo}#${attempt.data.pr}:${attempt.data.file}`);
        report.push(`  - Method: ${attempt.data.method}`);
        report.push(`  - Result: ${attempt.level}`);
        if (attempt.data.error) {
          report.push(`  - Error: ${attempt.data.error.substring(0, 200)}`);
        }
      }
      report.push('');
    }

    // Thinking logs
    if (this.thinkingLogs.length > 0) {
      report.push(`## Thinking Logs`);
      for (const thinking of this.thinkingLogs) {
        report.push(`### Round ${thinking.round}`);
        report.push(`Timestamp: ${thinking.timestamp}`);
        if (thinking.context?.file) {
          report.push(`File: ${thinking.context.file}`);
        }
        report.push('```');
        report.push(thinking.content);
        report.push('```');
        report.push('');
      }
    }

    return report.join('\n');
  }

  /**
   * Save session report to file
   */
  saveSessionReport(): string {
    const report = this.exportSessionReport();
    const filePath = path.join(this.logDir, `session-${this.sessionId}-report.md`);
    fs.writeFileSync(filePath, report);
    return filePath;
  }

  /**
   * Set context for subsequent logs
   */
  setContext(context: { repo?: string; pr?: number }): void {
    if (context.repo) {
      // Can be used to filter logs by repo
    }
    if (context.pr) {
      // Can be used to filter logs by PR
    }
  }

  /**
   * Increment round counter
   */
  incrementRound(): void {
    this.currentRound++;
  }

  /**
   * Get current round
   */
  getCurrentRound(): number {
    return this.currentRound;
  }

  /**
   * Get summary of logs
   */
  getSummary(): {
    totalLogs: number;
    byLevel: Record<string, number>;
    byCategory: Record<string, number>;
  } {
    const byLevel: Record<string, number> = {};
    const byCategory: Record<string, number> = {};

    for (const log of this.logs) {
      byLevel[log.level] = (byLevel[log.level] || 0) + 1;
      byCategory[log.category] = (byCategory[log.category] || 0) + 1;
    }

    return {
      totalLogs: this.logs.length,
      byLevel,
      byCategory
    };
  }

  /**
   * Generate diff quality report
   */
  generateDiffReport(
    patch: string,
    errors: string[] = [],
    warnings: string[] = []
  ): {
    isValid: boolean;
    validationErrors: string[];
    appliedChanges: string[];
    stats: { linesAdded: number; linesRemoved: number }
  } {
    const linesAdded = (patch.match(/^\+/gm) || []).length;
    const linesRemoved = (patch.match(/^-/gm) || []).length;

    return {
      isValid: errors.length === 0,
      validationErrors: errors,
      appliedChanges: warnings,
      stats: { linesAdded, linesRemoved }
    };
  }

  /**
   * Export logs to file
   */
  exportLogs(): string {
    const exportFile = path.join(this.logDir, `session-${this.sessionId}-export.json`);
    fs.writeFileSync(exportFile, JSON.stringify(this.logs, null, 2));
    return exportFile;
  }

  /**
   * Private: Log an entry
   */
  private log(level: string, category: string, message: string, data?: any): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: level as any,
      category,
      message,
      data,
      sessionId: this.sessionId
    };

    // Check log level
    const levelPriority = { debug: 0, info: 1, warn: 2, error: 3 };
    if (levelPriority[level] < levelPriority[this.logLevel]) {
      return;
    }

    this.logs.push(entry);

    // Console output with colors
    const colors = {
      info: '\x1b[36m',
      warn: '\x1b[33m',
      error: '\x1b[31m',
      debug: '\x1b[2m',
      success: '\x1b[32m',
      thinking: '\x1b[38;5;213m'
    };

    const color = colors[level] || '\x1b[0m';
    console.log(`${color}[${category}]\x1b[0m ${message}`);

    // Save to file
    if (this.saveToFile) {
      this.saveLog(entry);
    }
  }

  /**
   * Private: Save log entry to file
   */
  private saveLog(entry: LogEntry): void {
    try {
      const logFile = path.join(this.logDir, `session-${this.sessionId}.jsonl`);
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
    } catch (error) {
      console.error('Failed to save log:', error);
    }
  }

  /**
   * Private: Save thinking log to file
   */
  private saveThinkingLog(thinking: ThinkingLog): void {
    try {
      const thinkingFile = path.join(this.logDir, `session-${this.sessionId}-thinking.jsonl`);
      fs.appendFileSync(thinkingFile, JSON.stringify(thinking) + '\n');
    } catch (error) {
      console.error('Failed to save thinking log:', error);
    }
  }
}

/**
 * Create a logger instance for a specific session
 */
export function createSessionLogger(options: EnhancedLoggerOptions = {}): EnhancedLogger {
  return new EnhancedLogger(options);
}

/**
 * Global logger instance (for backward compatibility)
 */
export const globalLogger = new EnhancedLogger({
  sessionId: 'global',
  captureThinking: true,
  saveToFile: true
});
