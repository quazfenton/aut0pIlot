export interface GitHubEvent {
  event_type: string;
  payload: any;
  repo_full_name: string;
  pr_number: number;
}

export interface PRConfig {
  autofix: {
    enabled: boolean;
    max_iterations: number;
    allowed_bots: string[];
    risk_level: 'low' | 'medium' | 'high';
    branch_strategy: 'update_same_pr' | 'helper_pr';
    require_approval_for_risky: boolean;
    batching?: {
      enabled: boolean;
      max_wait_ms?: number;
      max_comments_per_commit?: number;
    };
    use_cli_tools?: boolean;
    format_after_fix?: boolean;
  };
  workflows?: {
    enabled: boolean;
    steps: WorkflowStep[];
  };
  exclude_paths?: string[];
  bot_settings?: Record<string, {
    process_all?: boolean;
    auto_apply_suggestions?: boolean;
  }>;
}

export interface WorkflowStep {
  name: string;
  type: 'patch' | 'command' | 'test' | 'lint';
  command?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  working_dir?: string;
  allow_failure?: boolean;
}

export interface ExtractedSuggestion {
  code: string;
  source: 'github' | 'coderabbit';
  section?: string;
}

export interface ParsedReviewComment {
  id: string;
  file: string;
  start_line: number;
  end_line: number;
  type: 'inline_comment' | 'suggested_change' | 'bot_review' | 'issue_comment';
  content: string;
  patch?: string | null;
  suggestions?: ExtractedSuggestion[];
  proposed_fixes?: string[];
  agent_prompt?: string;
  author: string;
  bot_name?: string;
  commit_sha: string;
  diff_hunk?: string;
  url?: string;
}

export interface PatchRequest {
  repo: string;
  pr: number;
  commit_sha: string;
  file: string;
  start_line: number;
  end_line: number;
  content: string;
  context?: string;
  diff_hunk?: string;
  suggestions?: ExtractedSuggestion[];
  proposed_fixes?: string[];
  agent_prompt?: string;
}

export interface PatchResult {
  success: boolean;
  patch?: string;
  error?: string;
  requires_approval: boolean;
}

export interface PRState {
  repo: string;
  pr: number;
  state: 'NEW' | 'REVIEWED' | 'FIXING' | 'PUSHED' | 'RECHECKING' | 'BLOCKED' | 'NEEDS_HUMAN' | 'FAILED';
  iteration: number;
  last_commit?: string;
  comments_processed: string[];
  pending_comments?: ParsedReviewComment[];
  blocked_reason?: string;
  helper_branch?: string; // The branch where autofixes are pushed (created from PR branch)
}

export type AutomationLevel = 1 | 2 | 3;

export interface FixStrategy {
  level: AutomationLevel;
  auto_apply: boolean;
  reason?: string;
}