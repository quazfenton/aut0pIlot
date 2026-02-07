// Type declaration for the specialized Qwen runner
declare module './qwen-specialized-runner.js' {
  export class QwenSpecializedRunner {
    constructor(repo: string, commitSha: string);
    cloneRepository(): Promise<void>;
    runQwenWithEnhancedContext(
      targetFile: string,
      startLine: number,
      endLine: number,
      comment: string,
      suggestions?: string[]
    ): Promise<string>;
    cleanup(): void;
  }
}