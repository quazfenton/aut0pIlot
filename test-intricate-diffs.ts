#!/usr/bin/env bun
/**
 * Advanced test script to verify intricate diff generation with proper LLM usage
 */

import { PatchGenerator } from './scripts/patch-generator';
import { PatchRequest } from './scripts/types';

// Intricate Diff Scenario 1: Multi-file dependency changes
const multiFileDependencyContent = `This function depends on a service that needs to be updated to support async operations.

\`\`\`suggestion
// Update the service interface
interface UserService {
  getUser(id: string): Promise<User>;
  createUser(userData: CreateUserDto): Promise<User>;
  updateUser(id: string, userData: UpdateUserDto): Promise<User>;
  deleteUser(id: string): Promise<boolean>;
}

// Update the implementation
class UserServiceImpl implements UserService {
  async getUser(id: string): Promise<User> {
    const response = await fetch(\`/api/users/\${id}\`);
    if (!response.ok) throw new Error(\`User \${id} not found\`);
    return response.json();
  }

  async createUser(userData: CreateUserDto): Promise<User> {
    const response = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData)
    });
    if (!response.ok) throw new Error('Failed to create user');
    return response.json();
  }

  async updateUser(id: string, userData: UpdateUserDto): Promise<User> {
    const response = await fetch(\`/api/users/\${id}\`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData)
    });
    if (!response.ok) throw new Error(\`Failed to update user \${id}\`);
    return response.json();
  }

  async deleteUser(id: string): Promise<boolean> {
    const response = await fetch(\`/api/users/\${id}\`, {
      method: 'DELETE'
    });
    return response.ok;
  }
}
\`\`\``;

// Intricate Diff Scenario 2: State management with side effects
const stateManagementContent = `Current state management has race conditions. Implement proper locking mechanism.

\`\`\`suggestion
class StateManager {
  private state: Map<string, any> = new Map();
  private locks: Map<string, Promise<void>> = new Map();
  private lockResolvers: Map<string, () => void> = new Map();

  async getValue<T>(key: string): Promise<T> {
    // Wait for any existing lock to be released
    const lockPromise = this.locks.get(key);
    if (lockPromise) {
      await lockPromise;
    }
    
    return this.state.get(key);
  }

  async setValue<T>(key: string, value: T): Promise<void> {
    // Acquire lock
    let resolveFn: () => void;
    const lockPromise = new Promise<void>(resolve => {
      resolveFn = resolve;
    });
    
    this.locks.set(key, lockPromise);
    this.lockResolvers.set(key, resolveFn!);

    try {
      // Perform the state update
      this.state.set(key, value);
      
      // Add any side effects here
      await this.triggerSideEffects(key, value);
    } finally {
      // Release lock
      const resolver = this.lockResolvers.get(key);
      if (resolver) {
        resolver();
        this.lockResolvers.delete(key);
      }
      this.locks.delete(key);
    }
  }

  private async triggerSideEffects<T>(key: string, value: T): Promise<void> {
    // Implement any side effects that should happen after state update
    console.log(\`State updated for \${key}: \${JSON.stringify(value)}\`);
    
    // Example: notify subscribers
    this.notifySubscribers(key, value);
  }

  private notifySubscribers<T>(key: string, value: T): void {
    // Notify any listeners about the state change
    console.log(\`Notifying subscribers for \${key}\`);
  }
}
\`\`\``;

// Intricate Diff Scenario 3: Complex algorithm with multiple edge cases
const complexAlgorithmContent = `The current search algorithm doesn't handle special characters and Unicode properly. Implement comprehensive text processing.

\`\`\`suggestion
class TextSearchEngine {
  private readonly SPECIAL_CHARS_REGEX = /[!@#$%^&*(),.?":{}|<>_=[\];'"?]+/g;
  private readonly UNICODE_WORD_BOUNDARY = /(?:^|\s|[\\p{P}\\p{S}])((?:[\\p{L}\\p{N}][\\p{Mn}]*)+)(?=\s|[\\p{P}\\p{S}]|$)/gu;

  /**
   * Searches for terms in a text with proper Unicode and special character handling
   */
  search(text: string, searchTerm: string, options: SearchOptions = {}): SearchResult[] {
    const { caseSensitive = false, wholeWord = false, fuzzy = false } = options;
    
    if (!text || !searchTerm) {
      return [];
    }

    // Normalize the search term
    let normalizedSearchTerm = searchTerm;
    if (!caseSensitive) {
      normalizedSearchTerm = searchTerm.toLowerCase();
    }

    // Process the text based on search options
    const results: SearchResult[] = [];
    
    if (fuzzy) {
      // Implement fuzzy search algorithm
      results.push(...this.fuzzySearch(text, normalizedSearchTerm, options));
    } else if (wholeWord) {
      // Search for whole words only
      results.push(...this.wholeWordSearch(text, normalizedSearchTerm, options));
    } else {
      // Standard substring search
      results.push(...this.substringSearch(text, normalizedSearchTerm, options));
    }

    return results.sort((a, b) => a.index - b.index);
  }

  private fuzzySearch(text: string, searchTerm: string, options: SearchOptions): SearchResult[] {
    // Implement fuzzy matching algorithm (e.g., Levenshtein distance)
    const results: SearchResult[] = [];
    const textLower = options.caseSensitive ? text : text.toLowerCase();
    
    // Simplified fuzzy search - in practice, you'd use a more sophisticated algorithm
    for (let i = 0; i <= textLower.length - searchTerm.length; i++) {
      const segment = textLower.substr(i, searchTerm.length);
      
      // Calculate similarity (simplified)
      const similarity = this.calculateSimilarity(segment, searchTerm);
      
      if (similarity > 0.7) { // Threshold for fuzzy match
        results.push({
          index: i,
          match: text.substr(i, searchTerm.length),
          score: similarity
        });
      }
    }
    
    return results;
  }

  private wholeWordSearch(text: string, searchTerm: string, options: SearchOptions): SearchResult[] {
    const results: SearchResult[] = [];
    const flags = options.caseSensitive ? 'g' : 'gi';
    
    // Create a regex that matches whole words
    const regex = new RegExp(\`\\\\b\${this.escapeRegExp(searchTerm)}\\\\b\`, flags);
    let match;
    
    while ((match = regex.exec(text)) !== null) {
      results.push({
        index: match.index,
        match: match[0],
        score: 1.0
      });
    }
    
    return results;
  }

  private substringSearch(text: string, searchTerm: string, options: SearchOptions): SearchResult[] {
    const results: SearchResult[] = [];
    const textToSearch = options.caseSensitive ? text : text.toLowerCase();
    const searchStart = options.caseSensitive ? searchTerm : searchTerm.toLowerCase();
    
    let startIndex = 0;
    let index;
    
    while ((index = textToSearch.indexOf(searchStart, startIndex)) !== -1) {
      results.push({
        index,
        match: text.substr(index, searchTerm.length),
        score: 1.0
      });
      
      startIndex = index + 1;
    }
    
    return results;
  }

  private calculateSimilarity(a: string, b: string): number {
    // Calculate similarity using a simple algorithm
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    
    if (longer.length === 0) {
      return 1.0;
    }
    
    const editDistance = this.computeEditDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  private computeEditDistance(s1: string, s2: string): number {
    // Compute edit distance using dynamic programming
    const m = s1.length;
    const n = s2.length;
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (s1[i - 1] === s2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = 1 + Math.min(
            dp[i - 1][j],     // deletion
            dp[i][j - 1],     // insertion
            dp[i - 1][j - 1]  // substitution
          );
        }
      }
    }

    return dp[m][n];
  }

  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^\${}$()|[\]\\]/g, '\\\\$&');
  }
}

interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  fuzzy?: boolean;
}

interface SearchResult {
  index: number;
  match: string;
  score: number;
}
\`\`\``;

// Intricate Diff Scenario 4: Security-hardened API endpoint
const securityHardenedContent = `Current API endpoint is vulnerable to various attacks. Implement comprehensive security measures.

\`\`\`suggestion
import rateLimit from 'express-rate-limit';
import validator from 'validator';
import { body, validationResult } from 'express-validator';

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true, // Return rate limit info in the 'RateLimit-*' headers
  legacyHeaders: false, // Disable the 'X-RateLimit-*' headers
});

// Input validation middleware
const validateUserInput = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .customSanitizer(email => email.toLowerCase())
    .withMessage('Must be a valid email'),
  body('password')
    .isLength({ min: 8 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least 8 characters with uppercase, lowercase, and number'),
  body('username')
    .isAlphanumeric()
    .isLength({ min: 3, max: 30 })
    .customSanitizer(username => username.trim())
    .withMessage('Username must be 3-30 alphanumeric characters'),
];

// Security-hardened endpoint
app.use('/api/users', limiter);

app.post('/api/users/register', validateUserInput, async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, username } = req.body;

    // Additional security checks
    if (await isEmailBlocked(email)) {
      return res.status(403).json({ error: 'Email is blocked' });
    }

    if (await isUsernameTaken(username)) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    // Sanitize inputs
    const sanitizedEmail = validator.normalizeEmail(email);
    const sanitizedUsername = validator.blacklist(username, '<>');

    // Hash password securely
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user with security measures
    const user = await createUser({
      email: sanitizedEmail,
      password: hashedPassword,
      username: sanitizedUsername,
      createdAt: new Date(),
      lastLoginAt: null,
      isActive: true,
      security: {
        loginAttempts: 0,
        lockedUntil: null,
        twoFactorEnabled: false,
        lastPasswordChange: new Date(),
      }
    });

    // Log security event
    await logSecurityEvent({
      userId: user.id,
      action: 'USER_REGISTERED',
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      timestamp: new Date()
    });

    // Send success response without sensitive data
    res.status(201).json({
      id: user.id,
      email: user.email,
      username: user.username,
      createdAt: user.createdAt
    });
  } catch (error) {
    console.error('Registration error:', error);

    // Don't leak specific error details to client
    if (error.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: 'User already exists' });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
});

// Additional security utilities
async function isEmailBlocked(email: string): Promise<boolean> {
  // Check against blocked domains/providers
  const blockedDomains = ['tempmail.com', 'throwaway.email'];
  const domain = email.split('@')[1];
  return blockedDomains.includes(domain);
}

async function isUsernameTaken(username: string): Promise<boolean> {
  // Check if username exists in database
  const existingUser = await db.users.findOne({ username });
  return !!existingUser;
}

async function logSecurityEvent(event: SecurityEvent): Promise<void> {
  // Log to security monitoring system
  console.log('SECURITY_EVENT:', JSON.stringify(event));
  // In production, send to SIEM system
}
\`\`\``;

// Intricate Diff Scenario 5: Indentation and Alignment with Continuations
const indentationAlignmentContent = `Python function call with split arguments needs a new argument added while preserving alignment.

\`\`\`suggestion
# Before
result = some_function(
    arg1,
    arg2,
    arg3)

# After
result = some_function(
    arg1,
    arg2,
    arg3,
    arg4)
\`\`\``;

// Intricate Diff Scenario 6: Multi-line Strings or Comments
const multilineStringContent = `Changes within multi-line strings or block comments require structural focus.

\`\`\`suggestion
# Before
"""
This is a multi-line
string.
"""

# After
"""
This is a multi-line
string with an edit.
"""
\`\`\``;

// Intricate Diff Scenario 7: Mixed Whitespace and Tabs
const mixedWhitespaceContent = `Python code changing from spaces to tabs with added line.

\`\`\`suggestion
# Before (spaces)
    if True:
        print("Hello")

# After (tabs)
\tif True:
\t\tprint("Hello")
\t\tprint("World")
\`\`\``;

// Intricate Diff Scenario 9: Aligned Columns in Tables
const alignedColumnsContent = `Markdown table adding a column and rows while maintaining alignment.

\`\`\`suggestion
# Before
   Name   | Age |
 |--------|-----|
 | Alice  | 25  |
 | Bob    | 30  |

# After
 | Name    | Age | City     |
 |---------|-----|----------|
 | Alice   | 25  | Paris    |
 | Bob     | 30  | New York |
\`\`\``;

// Intricate Diff Scenario 10: Nested Structures with Partial Changes
const nestedStructuresContent = `JSON with nested structure where only parts are modified.

\`\`\`suggestion
# Before
{
    "user": {
        "name": "Alice",
        "preferences": {
            "theme": "dark"
        }
    }
}

# After
{
    "user": {
        "name": "Alice",
        "preferences": {
            "theme": "light",
            "language": "en"
        }
    }
}
\`\`\``;

// Intricate Diff Scenario 11: Line Wrapping and Soft/Hard Breaks
const lineWrappingContent = `Text where lines are wrapped and changes occur across breaks.

\`\`\`suggestion
# Before
This is a very long line that needs
to be wrapped for readability.

# After
This is a very long line that needs to
be wrapped for readability and edited.
\`\`\``;

// Intricate Diff Scenario 12: Macro or Template Expansions
const macroTemplateContent = `C preprocessor macro change affecting downstream usage.

\`\`\`suggestion
# Before
#define MAX 100
int array[MAX];

# After
#define MAX 200
int array[MAX];
\`\`\``;

// Intricate Diff Scenario 13: Unicode or Special Characters
const unicodeContent = `File containing Unicode and emojis where changes involve these characters.

\`\`\`suggestion
# Before
Hello, world!

# After
Hello, 🌍!
\`\`\``;

// Intricate Diff Scenario 14: Contextual or Semantic Diffs
const semanticDiffsContent = `Semantic renaming of variables across a function.

\`\`\`suggestion
# Before
def calculate_total(price, quantity):
    return price * quantity

# After
def calculate_total(unit_price, units):
    return unit_price * units
\`\`\``;

// Intricate Diff Scenario 15: Ignored or Generated Content
const ignoredContentContent = `Auto-generated content where timestamp changes should be ignored.

\`\`\`suggestion
# Before
// Auto-generated on 2023-01-01
const VERSION = "1.0.0";

# After
// Auto-generated on 2023-02-01
const VERSION = "1.0.1";
\`\`\``;

// Intricate Diff Scenario 16: Partial Line Edits with Overlapping Context
const partialLineEditsContent = `Only a portion of a line changes with identical surrounding context.

\`\`\`suggestion
# Before
print("The answer is", 42)

# After
print("The answer is", 42, "!")
\`\`\``;

// Intricate Diff Scenario 17: Language-Specific Syntax (Ruby Blocks)
const rubySyntaxContent = `Ruby block syntax with array modification and operation change.

\`\`\`suggestion
# Before
[1, 2, 3].each do |x|
    puts x
end

# After
[1, 2, 3, 4].each do |x|
    puts x * 2
end
\`\`\``;

// Intricate Diff Scenario 18: Diffing Binary or Serialized Data
const binaryDataContent = `Base64 encoded data where changes occur in the encoded string.

\`\`\`suggestion
# Before
SGVsbG8gV29ybGQ=

# After
SGVsbG8gV29ybGQh
\`\`\``;

// Intricate Diff Scenario 19: Cross-File or Cross-Language Dependencies
const crossFileDependenciesContent = `API endpoint update spanning frontend and backend files.

\`\`\`suggestion
// Frontend Before
fetch("/api/v1/data")

// Frontend After
fetch("/api/v2/data")

// Backend Before
@app.route("/api/v1/data")

// Backend After
@app.route("/api/v2/data")
\`\`\``;

// Define test scenarios
const intricateScenarios = [
  {
    name: 'Multi-File Dependency Changes',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 10,
      commit_sha: 'main',
      file: 'services/user-service.ts',
      start_line: 1,
      end_line: 50,
      content: multiFileDependencyContent,
      diff_hunk: `@@ -1,5 +1,40 @@
-interface OldUserService {
-  getUser(id: string): User;
-}
+// Update the service interface
+interface UserService {
+  getUser(id: string): Promise<User>;
+  createUser(userData: CreateUserDto): Promise<User>;
+  updateUser(id: string, userData: UpdateUserDto): Promise<User>;
+  deleteUser(id: string): Promise<boolean>;
+}
+
+// Update the implementation
+class UserServiceImpl implements UserService {
+  async getUser(id: string): Promise<User> {
+    const response = await fetch(\`/api/users/\${id}\`);
+    if (!response.ok) throw new Error(\`User \${id} not found\`);
+    return response.json();
+  }
+
+  async createUser(userData: CreateUserDto): Promise<User> {
+    const response = await fetch('/api/users', {
+      method: 'POST',
+      headers: { 'Content-Type': 'application/json' },
+      body: JSON.stringify(userData)
+    });
+    if (!response.ok) throw new Error('Failed to create user');
+    return response.json();
+  }
+
+  // Additional methods...`,
    } as PatchRequest
  },
  {
    name: 'State Management with Race Conditions',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 11,
      commit_sha: 'main',
      file: 'state/state-manager.ts',
      start_line: 5,
      end_line: 25,
      content: stateManagementContent,
      diff_hunk: `@@ -5,20 +5,50 @@
-class SimpleState {
-  private data: any = {};
-  setValue(key: string, value: any) {
-    this.data[key] = value;
-  }
-  getValue(key: string) {
-    return this.data[key];
-  }
+class StateManager {
+  private state: Map<string, any> = new Map();
+  private locks: Map<string, Promise<void>> = new Map();
+  private lockResolvers: Map<string, () => void> = new Map();
+
+  async getValue<T>(key: string): Promise<T> {
+    // Wait for any existing lock to be released
+    const lockPromise = this.locks.get(key);
+    if (lockPromise) {
+      await lockPromise;
+    }
+    
+    return this.state.get(key);
+  }
+
+  async setValue<T>(key: string, value: T): Promise<void> {
+    // Acquire lock
+    let resolveFn: () => void;
+    const lockPromise = new Promise<void>(resolve => {
+      resolveFn = resolve;
+    });
+    
+    this.locks.set(key, lockPromise);
+    this.lockResolvers.set(key, resolveFn!);
+
+    try {
+      // Perform the state update
+      this.state.set(key, value);
+      
+      // Add any side effects here
+      await this.triggerSideEffects(key, value);
+    } finally {
+      // Release lock`,
    } as PatchRequest
  },
  {
    name: 'Complex Algorithm with Edge Cases',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 12,
      commit_sha: 'main',
      file: 'search/text-search.ts',
      start_line: 1,
      end_line: 100,
      content: complexAlgorithmContent,
      diff_hunk: `@@ -1,10 +1,150 @@
-class BasicSearch {
-  search(text: string, term: string) {
-    return text.indexOf(term);
-  }
+class TextSearchEngine {
+  private readonly SPECIAL_CHARS_REGEX = /[!@#$%^&*(),.?":{}|<>_=[\];'"?]+/g;
+  private readonly UNICODE_WORD_BOUNDARY = /(?:^|\\s|[\\p{P}\\p{S}])((?:[\\p{L}\\p{N}][\\p{Mn}]*)+)(?=\\s|[\\p{P}\\p{S}]|$)/gu;
+
+  /**
+   * Searches for terms in a text with proper Unicode and special character handling
+   */
+  search(text: string, searchTerm: string, options: SearchOptions = {}): SearchResult[] {
+    const { caseSensitive = false, wholeWord = false, fuzzy = false } = options;
+    
+    if (!text || !searchTerm) {
+      return [];
+    }
+
+    // Normalize the search term
+    let normalizedSearchTerm = searchTerm;
+    if (!caseSensitive) {
+      normalizedSearchTerm = searchTerm.toLowerCase();
+    }
+
+    // Process the text based on search options
+    const results: SearchResult[] = [];
+    
+    if (fuzzy) {
+      // Implement fuzzy search algorithm
+      results.push(...this.fuzzySearch(text, normalizedSearchTerm, options));
+    } else if (wholeWord) {
+      // Search for whole words only
+      results.push(...this.wholeWordSearch(text, normalizedSearchTerm, options));
+    } else {
+      // Standard substring search
+      results.push(...this.substringSearch(text, normalizedSearchTerm, options));
+    }
+
+    return results.sort((a, b) => a.index - b.index);
+  }
+
+  private fuzzySearch(text: string, searchTerm: string, options: SearchOptions): SearchResult[] {
+    // Implement fuzzy matching algorithm (e.g., Levenshtein distance)
+    const results: SearchResult[] = [];
+    const textLower = options.caseSensitive ? text : text.toLowerCase();
+    
+    // Simplified fuzzy search - in practice, you'd use a more sophisticated algorithm
+    for (let i = 0; i <= textLower.length - searchTerm.length; i++) {
+      const segment = textLower.substr(i, searchTerm.length);
+      
+      // Calculate similarity (simplified)
+      const similarity = this.calculateSimilarity(segment, searchTerm);
+      
+      if (similarity > 0.7) { // Threshold for fuzzy match
+        results.push({
+          index: i,
+          match: text.substr(i, searchTerm.length),
+          score: similarity
+        });
+      }
+    }
+    
+    return results;
+  }
+
+  // Additional methods...`,
    } as PatchRequest
  },
    {
    name: 'Security-Hardened API Endpoint',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 13,
      commit_sha: 'main',
      file: 'api/user-endpoint.ts',
      start_line: 1,
      end_line: 30,
      content: securityHardenedContent,
      diff_hunk: `@@ -1,15 +1,80 @@
-import express from 'express';
-const app = express();
-
-app.post('/api/users', (req, res) => {
-  // Simple user creation
-  const user = req.body;
-  // Save to DB
-  res.json({ success: true, user });
-});
+import express from 'express';
+import rateLimit from 'express-rate-limit';
+import validator from 'validator';
+import { body, validationResult } from 'express-validator';
+
+const app = express();
+
+// Rate limiting middleware
+const limiter = rateLimit({
+  windowMs: 15 * 60 * 1000, // 15 minutes
+  max: 100, // Limit each IP to 100 requests per windowMs
+  message: 'Too many requests from this IP, please try again later',
+  standardHeaders: true,
+  legacyHeaders: false,
+});
+
+// Input validation middleware
+const validateUserInput = [
+  body('email')
+    .isEmail()
+    .normalizeEmail()
+    .customSanitizer(email => email.toLowerCase())
+    .withMessage('Must be a valid email'),
+  body('password')
+    .isLength({ min: 8 })
+    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)/)
+    .withMessage('Password must contain at least 8 characters with uppercase, lowercase, and number'),
+];
+
+// Security-hardened endpoint
+app.use('/api/users', limiter);
+
+app.post('/api/users/register', validateUserInput, async (req, res) => {
+  try {
+    // Check for validation errors
+    const errors = validationResult(req);
+    if (!errors.isEmpty()) {
+      return res.status(400).json({ errors: errors.array() });
+    }
+
+    const { email, password } = req.body;
+
+    // Sanitize inputs
+    const sanitizedEmail = validator.normalizeEmail(email);
+    const hashedPassword = await bcrypt.hash(password, 12);
+
+    // Create user with security measures
+    const user = await createUser({
+      email: sanitizedEmail,
+      password: hashedPassword,
+      createdAt: new Date(),
+      security: {
+        loginAttempts: 0,
+        lockedUntil: null,
+      }
+    });
+
+    res.status(201).json({
+      id: user.id,
+      email: user.email,
+      createdAt: user.createdAt
+    });
+  } catch (error) {
+    console.error('Registration error:', error);
+    res.status(500).json({ error: 'Internal server error' });
+  }
+});`,
    } as PatchRequest
  },
  {
    name: 'Indentation and Alignment with Continuations',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 14,
      commit_sha: 'main',
      file: 'test-intricate-diffs.ts',
      start_line: 410,
      end_line: 426,
      content: indentationAlignmentContent,
      diff_hunk: `@@ -1,5 +1,6 @@
 result = some_function(
     arg1,
     arg2,
-    arg3)
+    arg3,
+    arg4)
 )`,
    } as PatchRequest
  },
  {
    name: 'Multi-line Strings or Comments',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 15,
      commit_sha: 'main',
      file: 'test-intricate-diffs.ts',
      start_line: 428,
      end_line: 443,
      content: multilineStringContent,
      diff_hunk: `@@ -1,5 +1,5 @@
 """
 This is a multi-line
-string.
+string with an edit.
 """`,
    } as PatchRequest
  },
  {
    name: 'Mixed Whitespace and Tabs',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 17,
      commit_sha: 'main',
      file: 'test-intricate-diffs.ts',
      start_line: 459,
      end_line: 472,
      content: mixedWhitespaceContent,
      diff_hunk: `@@ -1,3 +1,4 @@
-    if True:
-        print("Hello")
+\tif True:
+\t\tprint("Hello")
+\t\tprint("World")`,
    } as PatchRequest
  },
  {
    name: 'Aligned Columns in Tables',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 18,
      commit_sha: 'main',
      file: 'test-intricate-diffs.ts',
      start_line: 474,
      end_line: 489,
      content: alignedColumnsContent,
      diff_hunk: `@@ -1,5 +1,6 @@
    Name   | Age |
    -|--------|-----|
    -| Alice  | 25  |
    -| Bob    | 30  |
  +| Name    | Age | City     |
  +|---------|-----|----------|
  +| Alice   | 25  | Paris    |
  +| Bob     | 30  | New York |`,
    } as PatchRequest
  },
  {
    name: 'Nested Structures with Partial Changes',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 19,
      commit_sha: 'main',
      file: 'test-intricate-diffs.ts',
      start_line: 491,
      end_line: 514,
      content: nestedStructuresContent,
      diff_hunk: `@@ -1,12 +1,14 @@
 {
     "user": {
         "name": "Alice",
         "preferences": {
-            "theme": "dark"
+            "theme": "light",
+            "language": "en"
         }
     }
 }`,
    } as PatchRequest
  },
  {
    name: 'Line Wrapping and Soft/Hard Breaks',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 20,
      commit_sha: 'main',
      file: 'test-intricate-diffs.ts',
      start_line: 516,
      end_line: 528,
      content: lineWrappingContent,
      diff_hunk: `@@ -1,3 +1,3 @@
 This is a very long line that needs
-to be wrapped for readability.
+be wrapped for readability and edited.`,
    } as PatchRequest
  },
  {
    name: 'Macro or Template Expansions',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 21,
      commit_sha: 'main',
      file: 'test-intricate-diffs.ts',
      start_line: 530,
      end_line: 541,
      content: macroTemplateContent,
      diff_hunk: `@@ -1,3 +1,3 @@
-#define MAX 100
+#define MAX 200
 int array[MAX];`,
    } as PatchRequest
  },
  {
    name: 'Unicode or Special Characters',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 22,
      commit_sha: 'main',
      file: 'test-intricate-diffs.ts',
      start_line: 543,
      end_line: 552,
      content: unicodeContent,
      diff_hunk: `@@ -1,2 +1,2 @@
-Hello, world!
+Hello, 🌍!`,
    } as PatchRequest
  },
  {
    name: 'Contextual or Semantic Diffs',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 23,
      commit_sha: 'main',
      file: 'test-intricate-diffs.ts',
      start_line: 554,
      end_line: 565,
      content: semanticDiffsContent,
      diff_hunk: `@@ -1,3 +1,3 @@
-def calculate_total(price, quantity):
-    return price * quantity
+def calculate_total(unit_price, units):
+    return unit_price * units`,
    } as PatchRequest
  },
  {
    name: 'Ignored or Generated Content',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 24,
      commit_sha: 'main',
      file: 'test-intricate-diffs.ts',
      start_line: 567,
      end_line: 578,
      content: ignoredContentContent,
      diff_hunk: `@@ -1,3 +1,3 @@
 // Auto-generated on 2023-01-01
-const VERSION = "1.0.0";
+const VERSION = "1.0.1";`,
    } as PatchRequest
  },
  {
    name: 'Partial Line Edits with Overlapping Context',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 25,
      commit_sha: 'main',
      file: 'test-intricate-diffs.ts',
      start_line: 580,
      end_line: 589,
      content: partialLineEditsContent,
      diff_hunk: `@@ -1,1 +1,1 @@
-print("The answer is", 42)
+print("The answer is", 42, "!")`,
    } as PatchRequest
  },
  {
    name: 'Language-Specific Syntax (Ruby Blocks)',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 26,
      commit_sha: 'main',
      file: 'test-intricate-diffs.ts',
      start_line: 591,
      end_line: 604,
      content: rubySyntaxContent,
      diff_hunk: `@@ -1,4 +1,4 @@
-[1, 2, 3].each do |x|
-    puts x
+[1, 2, 3, 4].each do |x|
+    puts x * 2
 end`,
    } as PatchRequest
  },
  {
    name: 'Diffing Binary or Serialized Data',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 27,
      commit_sha: 'main',
      file: 'test-intricate-diffs.ts',
      start_line: 606,
      end_line: 615,
      content: binaryDataContent,
      diff_hunk: `@@ -1,1 +1,1 @@
-SGVsbG8gV29ybGQ=
+SGVsbG8gV29ybGQh`,
    } as PatchRequest
  },
  {
    name: 'Cross-File or Cross-Language Dependencies',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 28,
      commit_sha: 'main',
      file: 'test-intricate-diffs.ts',
      start_line: 617,
      end_line: 632,
      content: crossFileDependenciesContent,
      diff_hunk: `@@ -1,2 +1,2 @@
-fetch("/api/v1/data")
+fetch("/api/v2/data")

 // Backend (separate file)
 @app.route("/api/v1/data") -> @app.route("/api/v2/data")`,
    } as PatchRequest
  }
];

async function runDirectLLMTest(
  generator: PatchGenerator,
  testName: string,
  prompt: string
): Promise<{ success: boolean; output?: string; error?: string }> {
  console.log(`\n--- Direct LLM Call: ${testName} ---`);

  const anyGenerator = generator as unknown as {
    callLLM?: (p: string, r?: PatchRequest) => Promise<{ success: boolean; output?: string; error?: string }>;
  };

  if (!anyGenerator.callLLM) {
    return { success: false, error: 'callLLM not available on PatchGenerator' };
  }

  return anyGenerator.callLLM(prompt);
}

async function main() {
  console.log('========================================');
  console.log('INTRICATE DIFF GENERATION - DIRECT LLM CALLS');
  console.log('========================================\n');

  const runLLMTests =
    process.env.RUN_LLM_TESTS === 'true' &&
    (!!process.env.GEMINI_API_KEY || !!process.env.MISTRAL_API_KEY || process.env.ALLOW_QWEN === 'true');

  if (!runLLMTests) {
    console.log('Skipped: set RUN_LLM_TESTS=true and configure GEMINI_API_KEY, MISTRAL_API_KEY, or ALLOW_QWEN=true.');
    process.exit(0);
  }

  const generator = new PatchGenerator();

  try {
    for (const scenario of intricateScenarios) {
      console.log(`\n>>>>>>> Testing Intricate Scenario: ${scenario.name} <<<<<<<`);

      // Make direct LLM call with the scenario's content and diff_hunk
      const llmPrompt = `${scenario.request.content}

${scenario.request.diff_hunk}

TASK:
- Generate a unified diff ONLY for the file: ${scenario.request.file}
- Use headers: --- a/${scenario.request.file} and +++ b/${scenario.request.file}
- Include @@ hunk headers and enough context to apply cleanly
- Return ONLY the diff block; no explanations or extra text`;

      const result = await runDirectLLMTest(
        generator,
        scenario.name,
        llmPrompt
      );

      console.log(`Success: ${result.success}`);

      if (result.success && result.output) {
        console.log(`✓ LLM generated response (${result.output.length} chars):`);
        console.log(result.output.trim());

        // Attempt to extract and normalize the diff for this scenario
        const anyGenerator = generator as unknown as {
          extractPatchFromResponse?: (r: string) => string | null;
          normalizeUnifiedDiff?: (p: string, f: string) => string | null;
        };

        if (anyGenerator.extractPatchFromResponse) {
          const extracted = anyGenerator.extractPatchFromResponse(result.output);
          if (extracted) {
            const normalized = anyGenerator.normalizeUnifiedDiff
              ? anyGenerator.normalizeUnifiedDiff(extracted, scenario.request.file)
              : extracted;
            if (normalized) {
              console.log('\nSanitized diff:');
              console.log(normalized);
            } else {
              console.log('\nSanitized diff: INVALID (multi-file or malformed)');
            }
          } else {
            console.log('\nSanitized diff: NONE FOUND');
          }
        }
      } else {
        console.log(`✗ LLM call failed: ${result.error || 'Unknown error'}`);
      }
    }
  } finally {
    generator.cleanup();
  }

  console.log('\n========================================');
  console.log('INTRICATE TEST SUITE COMPLETE');
  console.log('========================================');

  console.log('\nSUMMARY:');
  console.log(`Total intricate scenarios tested: ${intricateScenarios.length}`);
  console.log(`All scenarios tested via direct LLM calls`);
}

main().catch(console.error);
