export class ReviewParser {
    /**
     * Parse GitHub pull_request_review_comment event
     */
    parseInlineComment(event) {
        console.log(`[PARSER] parseInlineComment called`);
        const comment = event.comment;
        const pullRequest = event.pull_request;
        console.log(`[PARSER] comment present: ${!!comment}, pull_request present: ${!!pullRequest}`);
        if (!comment || !pullRequest) {
            console.log(`[PARSER] Missing required fields: comment=${!!comment}, pull_request=${!!pullRequest}`);
            return null;
        }
        const result = {
            id: comment.id.toString(),
            file: comment.path,
            start_line: comment.start_line || comment.line,
            end_line: comment.end_line || comment.line,
            type: comment.in_reply_to_id ? 'inline_comment' : 'suggested_change',
            content: comment.body,
            author: comment.user.login,
            commit_sha: comment.commit_id,
            diff_hunk: comment.diff_hunk,
        };
        console.log(`[PARSER] Parsed inline comment: id=${result.id}, file=${result.file}, type=${result.type}, author=${result.author}, has_diff_hunk=${!!result.diff_hunk}`);
        return result;
    }
    /**
     * Parse GitHub pull_request_review event (bot or human review)
     */
    parseReview(event) {
        console.log(`[PARSER] parseReview called`);
        const comments = [];
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
            const inlineSuggestions = this.extractInlineSuggestions(review.body, pullRequest.head?.repo?.full_name || '', pullRequest.number, author, commitSha, botName);
            console.log(`[PARSER] Extracted ${inlineSuggestions.length} inline suggestions from review body`);
            comments.push(...inlineSuggestions);
        }
        // Parse individual review comments
        if (review.comments && Array.isArray(review.comments)) {
            console.log(`[PARSER] Parsing ${review.comments.length} review comments`);
            for (const comment of review.comments) {
                if (comment.body) {
                    comments.push({
                        id: comment.id.toString(),
                        file: comment.path,
                        start_line: comment.start_line || comment.line,
                        end_line: comment.end_line || comment.line,
                        type: isBot ? 'bot_review' : 'inline_comment',
                        content: comment.body,
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
    parseIssueComment(event) {
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
            type: 'issue_comment',
            content: comment.body,
            author: comment.user?.login || 'unknown',
            commit_sha: '',
        };
        console.log(`[PARSER] Parsed issue comment: id=${result.id}, author=${result.author}`);
        return result;
    }
    /**
     * Extract inline suggestions from review body
     * Handles CodeRabbit-style suggestions and GitHub suggestion syntax
     */
    extractInlineSuggestions(body, repo, pr, author, commitSha, botName) {
        const suggestions = [];
        // GitHub suggestion format: ```suggestion\n...\n```
        const suggestionRegex = /```suggestion\n([\s\S]*?)\n```/g;
        let match;
        while ((match = suggestionRegex.exec(body)) !== null) {
            const suggestionContent = match[1];
            // Try to extract file and line from context before the suggestion
            const beforeText = body.substring(0, match.index);
            const fileMatch = beforeText.match(/`?([^`\n]+\.[a-z]+)`?\s*[:\n]/i);
            const file = fileMatch ? fileMatch[1] : '';
            // Extract line number if available (simplified)
            const lineMatch = beforeText.match(/line\s*(\d+)/i);
            const line = lineMatch ? parseInt(lineMatch[1]) : 0;
            suggestions.push({
                id: `suggestion-${match.index}`,
                file: file || '',
                start_line: line || 0,
                end_line: line || 0,
                type: 'suggested_change',
                content: suggestionContent,
                patch: this.formatPatch(suggestionContent),
                author: author,
                bot_name: botName,
                commit_sha: commitSha,
            });
        }
        // CodeRabbit-specific format: often includes file references and fix suggestions
        if (botName === 'coderabbit') {
            const coderabbitMatches = this.parseCodeRabbitSuggestions(body, repo, pr, author, commitSha);
            suggestions.push(...coderabbitMatches);
        }
        return suggestions;
    }
    /**
     * Parse CodeRabbit-specific suggestion format
     */
    parseCodeRabbitSuggestions(body, repo, pr, author, commitSha) {
        const suggestions = [];
        // CodeRabbit often provides suggestions like:
        // "Fix this by replacing X with Y"
        // with file references in brackets
        const fixRegex = /\[([^\]]+)\]:?\s*[:\-]\s*([^\n]+(?:\n(?!\[)[^\n]+)*)/g;
        let match;
        while ((match = fixRegex.exec(body)) !== null) {
            const fileRef = match[1];
            const suggestion = match[2].trim();
            // Extract file path from reference (e.g., "src/foo.js" or "src/foo.js:42")
            const filePathMatch = fileRef.match(/^([^\s:]+)/);
            const filePath = filePathMatch ? filePathMatch[1] : '';
            const lineMatch = fileRef.match(/:(\d+)/);
            const line = lineMatch ? parseInt(lineMatch[1]) : 0;
            if (filePath) {
                suggestions.push({
                    id: `coderabbit-${match.index}`,
                    file: filePath,
                    start_line: line,
                    end_line: line,
                    type: 'suggested_change',
                    content: suggestion,
                    patch: null, // Will be generated by LLM
                    author: author,
                    bot_name: 'coderabbit',
                    commit_sha: commitSha,
                });
            }
        }
        return suggestions;
    }
    /**
     * Format suggestion as a unified diff patch
     */
    formatPatch(suggestion) {
        const lines = suggestion.split('\n');
        let patch = '';
        for (const line of lines) {
            patch += `+${line}\n`;
        }
        return patch;
    }
    /**
     * Determine if a comment requires approval based on content
     */
    requiresApproval(comment, riskLevel) {
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
    filterComments(comments, config) {
        if (!config.autofix?.enabled) {
            console.log(`[FILTER] Autofix disabled, returning empty`);
            return [];
        }
        const normalizeBotName = (name) => {
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
