import { ParsedReviewComment, ExtractedSuggestion } from './types';

export class ReviewParser {
  /**
   * Parse GitHub pull_request_review_comment event
   */
  parseInlineComment(event: any): ParsedReviewComment | null {
    console.log(`[PARSER] parseInlineComment called`);
    
    const comment = event.comment;
    const pullRequest = event.pull_request;

    console.log(`[PARSER] comment present: ${!!comment}, pull_request present: ${!!pullRequest}`);
    
    if (!comment || !pullRequest) {
      console.log(`[PARSER] Missing required fields: comment=${!!comment}, pull_request=${!!pullRequest}`);
      return null;
    }

    const body: string = comment.body || '';
    const hasSuggestion = /```suggestion\b/i.test(body);
    const { suggestions, proposed_fixes, agent_prompt } = this.extractStructuredContent(body);

    const type: ParsedReviewComment['type'] = hasSuggestion || suggestions.length > 0
      ? 'suggested_change'
      : 'inline_comment';

    const result: ParsedReviewComment = {
      id: comment.id.toString(),
      file: comment.path,
      start_line: comment.start_line || comment.line,
      end_line: comment.end_line || comment.line,
      type,
      content: body,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
      proposed_fixes: proposed_fixes.length > 0 ? proposed_fixes : undefined,
      agent_prompt: agent_prompt || undefined,
      author: comment.user.login,
      commit_sha: comment.commit_id,
      diff_hunk: comment.diff_hunk,
    };

    console.log(`[PARSER] Parsed inline comment: id=${result.id}, file=${result.file}, type=${result.type}, author=${result.author}, has_diff_hunk=${!!result.diff_hunk}, suggestions=${suggestions.length}, proposed_fixes=${proposed_fixes.length}, has_agent_prompt=${!!agent_prompt}`);
    
    return result;
  }

  /**
   * Parse GitHub pull_request_review event (bot or human review)
   */
  parseReview(event: any): ParsedReviewComment[] {
    console.log(`[PARSER] parseReview called`);
    
    const comments: ParsedReviewComment[] = [];
    const review = event.review;
    const pullRequest = event.pull_request;

    console.log(`[PARSER] review present: ${!!review}, pull_request present: ${!!pullRequest}`);

    if (!review || !pullRequest) {
      console.log(`[PARSER] Missing required fields: review=${!!review}, pull_request=${!!pullRequest}`);
      return comments;
    }

    const author = review.user?.login || 'unknown';
    const commitSha = review.commit_id || pullRequest.head?.sha;

    // Check if this is a bot review
    const isBot = review.user?.type === 'Bot';
    const botName = isBot ? author.split('[bot]')[0] : undefined;

    console.log(`[PARSER] Review by ${author}, isBot=${isBot}, botName=${botName}`);

    // Parse review body for inline suggestions
    if (review.body) {
      console.log(`[PARSER] Parsing review body (${review.body.length} chars)`);
      const inlineSuggestions = this.extractInlineSuggestions(
        review.body,
        pullRequest.head?.repo?.full_name || '',
        pullRequest.number,
        author,
        commitSha,
        botName
      );
      console.log(`[PARSER] Extracted ${inlineSuggestions.length} inline suggestions from review body`);
      comments.push(...inlineSuggestions);
    }

    // Parse individual review comments
    if (review.comments && Array.isArray(review.comments)) {
      console.log(`[PARSER] Parsing ${review.comments.length} review comments`);
      for (const comment of review.comments) {
        if (comment.body) {
          const { suggestions, proposed_fixes, agent_prompt } = this.extractStructuredContent(comment.body);
          const hasSuggestion = /```suggestion\b/i.test(comment.body) || suggestions.length > 0;
          comments.push({
            id: comment.id.toString(),
            file: comment.path,
            start_line: comment.start_line || comment.line,
            end_line: comment.end_line || comment.line,
            type: hasSuggestion ? 'suggested_change' : (isBot ? 'bot_review' : 'inline_comment'),
            content: comment.body,
            suggestions: suggestions.length > 0 ? suggestions : undefined,
            proposed_fixes: proposed_fixes.length > 0 ? proposed_fixes : undefined,
            agent_prompt: agent_prompt || undefined,
            author: author,
            bot_name: botName,
            commit_sha: commitSha,
            diff_hunk: comment.diff_hunk,
          });
        }
      }
    }

    console.log(`[PARSER] Total parsed from review: ${comments.length} comments`);
    return comments;
  }

  /**
   * Parse issue_comment event on PR
   */
  parseIssueComment(event: any): ParsedReviewComment | null {
    console.log(`[PARSER] parseIssueComment called`);
    
    const comment = event.comment;
    const issue = event.issue;

    console.log(`[PARSER] comment present: ${!!comment}, issue present: ${!!issue}`);

    if (!comment || !issue || !issue.pull_request) {
      console.log(`[PARSER] Missing required fields or not a PR comment`);
      return null;
    }

    const result = {
      id: comment.id.toString(),
      file: '', // Issue comments aren't file-specific
      start_line: 0,
      end_line: 0,
      type: 'issue_comment' as const,
      content: comment.body,
      author: comment.user?.login || 'unknown',
      commit_sha: '',
    };

    console.log(`[PARSER] Parsed issue comment: id=${result.id}, author=${result.author}`);
    return result;
  }

  /**
   * Extract structured content from a comment body:
   * - GitHub ```suggestion blocks
   * - CodeRabbit "Proposed fix" / "Committable suggestion" code blocks
   * - "Prompt for AI Agents" section text
   */
  extractStructuredContent(body: string): {
    suggestions: ExtractedSuggestion[];
    proposed_fixes: string[];
    agent_prompt: string;
  } {
    const suggestions: ExtractedSuggestion[] = [];
    const proposed_fixes: string[] = [];
    let agent_prompt = '';

    // 1. Extract all ```suggestion blocks (GitHub native format)
    const suggestionRegex = /```suggestion\b[^\n]*\n([\s\S]*?)```/g;
    let match;
    while ((match = suggestionRegex.exec(body)) !== null) {
      const code = match[1].replace(/\r\n/g, '\n').trimEnd();
      if (code) {
        suggestions.push({ code, source: 'github', section: 'suggestion' });
      }
    }

    // 2. Extract CodeRabbit "Committable suggestion" section (contains ```suggestion blocks)
    const committableMatch = body.match(/(?:committable\s+suggestion|suggested\s+change)[^\n]*\n([\s\S]*?)(?=\n(?:#{1,6}\s|🤖|⚠️|\*\*)|$)/i);
    if (committableMatch) {
      const sectionBody = committableMatch[1];
      const innerSuggestionRegex = /```suggestion\b[^\n]*\n([\s\S]*?)```/g;
      let innerMatch;
      while ((innerMatch = innerSuggestionRegex.exec(sectionBody)) !== null) {
        const code = innerMatch[1].replace(/\r\n/g, '\n').trimEnd();
        if (code && !suggestions.some(s => s.code === code)) {
          suggestions.push({ code, source: 'coderabbit', section: 'committable_suggestion' });
        }
      }
    }

    // 3. Extract "Proposed fix" code blocks
    const proposedFixMatch = body.match(/(?:proposed\s+fix|suggested\s+fix)[^\n]*\n([\s\S]*?)(?=\n(?:#{1,6}\s|🤖|⚠️|\*\*Committable|\*\*Prompt)|$)/i);
    if (proposedFixMatch) {
      const sectionBody = proposedFixMatch[1];
      const codeBlockRegex = /```(?:\w+)?\n([\s\S]*?)```/g;
      let codeMatch;
      while ((codeMatch = codeBlockRegex.exec(sectionBody)) !== null) {
        const code = codeMatch[1].replace(/\r\n/g, '\n').trimEnd();
        if (code) {
          proposed_fixes.push(code);
        }
      }
    }

    // 4. Extract "Prompt for AI Agents" section
    const agentPromptMatch = body.match(/(?:prompt\s+for\s+ai\s+agents?)[^\n]*\n([\s\S]*?)(?=\n(?:#{1,6}\s|<!--)|$)/i);
    if (agentPromptMatch) {
      agent_prompt = agentPromptMatch[1].trim();
    }

    return { suggestions, proposed_fixes, agent_prompt };
  }

  /**
   * Extract inline suggestions from review body
   * Handles CodeRabbit-style suggestions and GitHub suggestion syntax
   */
  private extractInlineSuggestions(
    body: string,
    repo: string,
    pr: number,
    author: string,
    commitSha: string,
    botName?: string
  ): ParsedReviewComment[] {
    const comments: ParsedReviewComment[] = [];

    const { suggestions, proposed_fixes, agent_prompt } = this.extractStructuredContent(body);

    // GitHub suggestion format: ```suggestion\n...\n```
    const suggestionRegex = /```suggestion\b[^\n]*\n([\s\S]*?)```/g;
    let match;

    while ((match = suggestionRegex.exec(body)) !== null) {
      const beforeText = body.substring(0, match.index);
      const fileMatch = beforeText.match(/(?:^|\s|`)([a-zA-Z0-9_\-./]+\.[a-z]{1,10})`?\s*[:\n]/im);
      const file = fileMatch ? fileMatch[1] : '';
      
      const lineMatch = beforeText.match(/line\s*(\d+)/i);
      const line = lineMatch ? parseInt(lineMatch[1]) : 0;

      comments.push({
        id: `suggestion-${match.index}`,
        file: file || '',
        start_line: line || 0,
        end_line: line || 0,
        type: 'suggested_change' as const,
        content: body,
        suggestions,
        proposed_fixes: proposed_fixes.length > 0 ? proposed_fixes : undefined,
        agent_prompt: agent_prompt || undefined,
        author: author,
        bot_name: botName,
        commit_sha: commitSha,
      });
    }

    // If no suggestion blocks found but there are proposed fixes, still create comments
    if (comments.length === 0 && (proposed_fixes.length > 0 || agent_prompt)) {
      const fileMatch = body.match(/(?:^|\s|`)([a-zA-Z0-9_\-./]+\.[a-z]{1,10})`?\s*[:\n]/im);
      const file = fileMatch ? fileMatch[1] : '';
      const lineMatch = body.match(/line\s*(\d+)/i);
      const line = lineMatch ? parseInt(lineMatch[1]) : 0;

      comments.push({
        id: `proposed-fix-${Date.now()}`,
        file: file || '',
        start_line: line || 0,
        end_line: line || 0,
        type: proposed_fixes.length > 0 ? 'suggested_change' as const : 'bot_review' as const,
        content: body,
        proposed_fixes: proposed_fixes.length > 0 ? proposed_fixes : undefined,
        agent_prompt: agent_prompt || undefined,
        author: author,
        bot_name: botName,
        commit_sha: commitSha,
      });
    }

    return comments;
  }

  /**
   * Determine if a comment requires approval based on content
   */
  requiresApproval(comment: ParsedReviewComment, riskLevel: string): boolean {
    // High-risk keywords
    const riskyKeywords = [
      'security',
      'vulnerability',
      'authentication',
      'authorization',
      'api change',
      'breaking change',
      'architecture',
      'refactor',
      'database schema',
      'migration',
    ];

    const contentLower = comment.content.toLowerCase();
    const hasRiskyKeyword = riskyKeywords.some(kw => contentLower.includes(kw));

    // Level 3 changes always require approval
    if (riskLevel === 'low' && hasRiskyKeyword) {
      return true;
    }

    // Suggested changes from bots can be auto-applied if configured
    if (comment.type === 'suggested_change' && riskLevel !== 'low') {
      return false;
    }

    // Bot reviews are generally safer
    if (comment.type === 'bot_review' && riskLevel !== 'low') {
      return false;
    }

    return hasRiskyKeyword;
  }

  /**
   * Filter comments based on configuration
   */
  filterComments(
    comments: ParsedReviewComment[],
    config: any
  ): ParsedReviewComment[] {
    if (!config.autofix?.enabled) {
      console.log(`[FILTER] Autofix disabled, returning empty`);
      return [];
    }

    const normalizeBotName = (name: string): string => {
      return name.toLowerCase().replace(/[\-_]/g, '').replace(/\[bot\]$/, '');
    };

    const normalizedAllowedBots = (config.autofix.allowed_bots || []).map(normalizeBotName);
    
    console.log(`[FILTER] Config: autofix.enabled=${config.autofix.enabled}, risk_level=${config.autofix.risk_level}`);
    console.log(`[FILTER] Allowed bots: ${JSON.stringify(config.autofix.allowed_bots)}`);
    console.log(`[FILTER] Normalized allowed bots: ${JSON.stringify(normalizedAllowedBots)}`);

    const filtered = comments.filter(comment => {
      console.log(`[FILTER] Checking comment ${comment.id} by ${comment.author} (type=${comment.type})`);
      
      // Filter by bot whitelist if author is a bot
      const isBot = comment.author.includes('[bot]') || comment.bot_name;
      if (isBot) {
        const botName = comment.bot_name || comment.author.replace('[bot]', '');
        const normalizedBotName = normalizeBotName(botName);
        
        // Check exact match first
        const isAllowedExact = config.autofix.allowed_bots?.includes(botName);
        // Check normalized match
        const isAllowedNormalized = normalizedAllowedBots.includes(normalizedBotName);
        // Check bot_settings
        const hasBotSettings = config.bot_settings?.[botName]?.process_all;
        
        const isAllowed = isAllowedExact || isAllowedNormalized || hasBotSettings;
        
        console.log(`[FILTER] Bot ${botName} (normalized: ${normalizedBotName}) allowed: ${isAllowed} (exact: ${isAllowedExact}, normalized: ${isAllowedNormalized}, settings: ${hasBotSettings})`);
        return isAllowed;
      }

      // Always process human comments
      console.log(`[FILTER] Human comment, allowing`);
      return true;
    });

    console.log(`[FILTER] ${filtered.length}/${comments.length} comments passed filter`);
    return filtered;
  }
}
