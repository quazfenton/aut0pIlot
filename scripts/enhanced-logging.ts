import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface LogEntry {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' | 'DEBUG';
  category: string;
  message: string;
  metadata?: any;
  diff?: DiffAnalysis;
}

export interface DiffAnalysis {
  originalFile?: string;
  modifiedFile?: string;
  patch?: string;
  validationErrors: string[];
  repairAttempts: number;
  finalResult: 'SUCCESS' | 'FAILED' | 'PARTIAL';
  warnings: string[];
  appliedChanges: Array<{
    file: string;
    lines: number[];
    type: 'ADD' | 'REMOVE' | 'MODIFY';
  }>;
}

export class EnhancedLogger {
  private logFile: string;
  private diffLogFile: string;
  private entries: LogEntry[] = [];

  constructor(sessionId: string) {
    const logDir = path.join(os.tmpdir(), 'pr-autopilot-logs');
    fs.mkdirSync(logDir, { recursive: true });
    
    this.logFile = path.join(logDir, `session-${sessionId}.jsonl`);
    this.diffLogFile = path.join(logDir, `diff-analysis-${sessionId}.json`);
  }

  log(level: LogEntry['level'], category: string, message: string, metadata?: any, diff?: DiffAnalysis): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      metadata,
      diff
    };

    this.entries.push(entry);
    this.writeToFile(entry);
    this.outputToConsole(entry);
  }

  info(category: string, message: string, metadata?: any): void {
    this.log('INFO', category, message, metadata);
  }

  warn(category: string, message: string, metadata?: any): void {
    this.log('WARN', category, message, metadata);
  }

  error(category: string, message: string, metadata?: any): void {
    this.log('ERROR', category, message, metadata);
  }

  success(category: string, message: string, metadata?: any): void {
    this.log('SUCCESS', category, message, metadata);
  }

  debug(category: string, message: string, metadata?: any): void {
    this.log('DEBUG', category, message, metadata);
  }

  logPatchAnalysis(diff: DiffAnalysis): void {
    this.log('INFO', 'PATCH_ANALYSIS', 'Patch analysis completed', null, diff);
    
    // Also write detailed diff analysis to separate file
    try {
      fs.writeFileSync(this.diffLogFile, JSON.stringify(diff, null, 2));
    } catch (error) {
      this.error('FILE_IO', `Failed to write diff analysis: ${error}`);
    }
  }

  generateDiffReport(patch: string, validationErrors: string[], appliedFiles: string[]): DiffAnalysis {
    const analysis: DiffAnalysis = {
      patch,
      validationErrors,
      repairAttempts: 0,
      finalResult: validationErrors.length === 0 ? 'SUCCESS' : 'FAILED',
      warnings: [],
      appliedChanges: this.parsePatchChanges(patch, appliedFiles)
    };

    // Analyze patch for common issues
    if (patch) {
      analysis.warnings = this.analyzePatchQuality(patch);
    }

    return analysis;
  }

  private parsePatchChanges(patch: string, appliedFiles: string[]): Array<{
    file: string;
    lines: number[];
    type: 'ADD' | 'REMOVE' | 'MODIFY';
  }> {
    const changes: Array<{ file: string; lines: number[]; type: 'ADD' | 'REMOVE' | 'MODIFY' }> = [];
    const lines = patch.split('\n');
    let currentFile = '';
    let currentLine = 0;

    for (const line of lines) {
      if (line.startsWith('--- a/')) {
        currentFile = line.substring(6);
        currentLine = 0;
      } else if (line.startsWith('+++ b/')) {
        currentFile = line.substring(6);
      } else if (line.startsWith('@@')) {
        const match = line.match(/@@ -(\d+)/);
        if (match) {
          currentLine = parseInt(match[1]);
        }
      } else if (line.startsWith('+')) {
        changes.push({
          file: currentFile,
          lines: [currentLine],
          type: 'ADD'
        });
        currentLine++;
      } else if (line.startsWith('-')) {
        changes.push({
          file: currentFile,
          lines: [currentLine],
          type: 'REMOVE'
        });
      } else if (line.startsWith(' ')) {
        currentLine++;
      }
    }

    return changes;
  }

  private analyzePatchQuality(patch: string): string[] {
    const warnings: string[] = [];
    const lines = patch.split('\n');

    // Check for common patch issues
    let hasFileHeaders = false;
    let hasHunkHeaders = false;
    let hasContextLines = false;
    let hasChanges = false;

    for (const line of lines) {
      if (line.startsWith('--- a/') || line.startsWith('+++ b/')) {
        hasFileHeaders = true;
      } else if (line.startsWith('@@')) {
        hasHunkHeaders = true;
      } else if (line.startsWith(' ')) {
        hasContextLines = true;
      } else if (line.startsWith('+') || line.startsWith('-')) {
        hasChanges = true;
      }
    }

    if (!hasFileHeaders) {
      warnings.push('Missing file headers (--- a/file, +++ b/file)');
    }

    if (!hasHunkHeaders) {
      warnings.push('Missing hunk headers (@@ -line,count +line,count @@)');
    }

    if (!hasContextLines) {
      warnings.push('No context lines found - patch may be fragile');
    }

    if (!hasChanges) {
      warnings.push('No actual changes found in patch');
    }

    // Check for trailing whitespace
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].endsWith(' ')) {
        warnings.push(`Trailing whitespace on line ${i + 1}`);
        break;
      }
    }

    return warnings;
  }

  private writeToFile(entry: LogEntry): void {
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    } catch (error) {
      console.error('Failed to write log entry to file:', error);
    }
  }

  private outputToConsole(entry: LogEntry): void {
    const timestamp = new Date(entry.timestamp).toLocaleTimeString();
    const colors = {
      INFO: '\x1b[36m',      // Cyan
      WARN: '\x1b[33m',      // Yellow
      ERROR: '\x1b[31m',     // Red
      SUCCESS: '\x1b[32m',   // Green
      DEBUG: '\x1b[90m'      // Gray
    };

    const reset = '\x1b[0m';
    const color = colors[entry.level] || colors.INFO;
    
    let message = `[${timestamp}] ${color}${entry.level}\x1b[0m [${entry.category}] ${entry.message}`;
    
    if (entry.diff) {
      const { validationErrors, repairAttempts, finalResult, appliedChanges } = entry.diff;
      message += `\n  📊 Patch: ${finalResult} (${repairAttempts} attempts)`;
      
      if (validationErrors.length > 0) {
        message += `\n  ❌ Errors: ${validationErrors.join(', ')}`;
      }
      
      if (appliedChanges.length > 0) {
        message += `\n  ✅ Changes: ${appliedChanges.length} files modified`;
      }
    }

    console.log(message);
  }

  getSummary(): {
    total: number;
    byLevel: Record<string, number>;
    byCategory: Record<string, number>;
    errors: LogEntry[];
    warnings: LogEntry[];
  } {
    const summary = {
      total: this.entries.length,
      byLevel: {} as Record<string, number>,
      byCategory: {} as Record<string, number>,
      errors: [] as LogEntry[],
      warnings: [] as LogEntry[]
    };

    for (const entry of this.entries) {
      summary.byLevel[entry.level] = (summary.byLevel[entry.level] || 0) + 1;
      summary.byCategory[entry.category] = (summary.byCategory[entry.category] || 0) + 1;
      
      if (entry.level === 'ERROR') {
        summary.errors.push(entry);
      } else if (entry.level === 'WARN') {
        summary.warnings.push(entry);
      }
    }

    return summary;
  }

  exportLogs(filePath?: string): string {
    const outputPath = filePath || path.join(os.tmpdir(), `pr-autopilot-export-${Date.now()}.json`);
    const exportData = {
      sessionId: path.basename(this.logFile).replace('session-', '').replace('.jsonl', ''),
      timestamp: new Date().toISOString(),
      summary: this.getSummary(),
      entries: this.entries
    };

    try {
      fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2));
      return outputPath;
    } catch (error) {
      throw new Error(`Failed to export logs: ${error}`);
    }
  }
}
