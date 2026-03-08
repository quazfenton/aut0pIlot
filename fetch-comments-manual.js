#!/usr/bin/env node
/**
 * fetch-pr-comments.js
 * 
 * Fetches all review comments, issue comments, and review summaries from a GitHub PR
 * and saves them as both JSON and Markdown files.
 *
 * Usage:
 *   GITHUB_TOKEN=your_token node fetch-pr-comments.js
 *
 * Or edit the CONFIG block below directly.
 *
 * Output files:
 *   pr-comments.json   — structured data
 *   pr-comments.md     — human-readable markdown
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const OWNER = "quazfenton";
const REPO  = "binG";
const PR    = 15;
const TOKEN = process.env.GITHUB_TOKEN || ""; // set via env or paste here
// ─────────────────────────────────────────────────────────────────────────────

const https = require("https");
const fs    = require("fs");
const path  = require("path");

function ghFetch(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: endpoint,
      headers: {
        "User-Agent": "pr-comment-fetcher",
        "Accept": "application/vnd.github+json",
        ...(TOKEN ? { "Authorization": `Bearer ${TOKEN}` } : {}),
      },
    };
    let data = "";
    const req = https.get(options, (res) => {
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error("JSON parse error: " + data)); }
      });
    });
    req.on("error", reject);
  });
}

async function fetchAllPages(endpoint) {
  let results = [];
  let page = 1;
  while (true) {
    const sep = endpoint.includes("?") ? "&" : "?";
    const { status, body } = await ghFetch(`${endpoint}${sep}per_page=100&page=${page}`);
    if (status !== 200) {
      console.error(`GitHub API error (${status}):`, JSON.stringify(body));
      break;
    }
    if (!Array.isArray(body) || body.length === 0) break;
    results = results.concat(body);
    if (body.length < 100) break;
    page++;
  }
  return results;
}

async function fetchReviews(endpoint) {
  // Reviews use the same pagination but return all at once usually
  const { status, body } = await ghFetch(endpoint);
  if (status !== 200) {
    console.error(`Reviews API error (${status}):`, JSON.stringify(body));
    return [];
  }
  return Array.isArray(body) ? body : [];
}

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleString() : "unknown";
}

function stripHtml(text) {
  return (text || "").replace(/<[^>]+>/g, "").trim();
}

async function main() {
  if (!TOKEN) {
    console.warn("⚠️  No GITHUB_TOKEN set. You may hit rate limits on large PRs.");
  }

  const base = `/repos/${OWNER}/${REPO}/pulls/${PR}`;

  console.log("Fetching PR info...");
  const { body: pr } = await ghFetch(base);

  console.log("Fetching review comments (inline code comments)...");
  const reviewComments = await fetchAllPages(`${base}/comments`);

  console.log("Fetching issue comments (general PR discussion)...");
  const issueComments = await fetchAllPages(`/repos/${OWNER}/${REPO}/issues/${PR}/comments`);

  console.log("Fetching reviews (approve/request-changes with body)...");
  const reviews = await fetchAllPages(`${base}/reviews`);

  // ── Build structured JSON ──────────────────────────────────────────────────

  const output = {
    pr: {
      number: PR,
      title: pr.title,
      url: pr.html_url,
      author: pr.user?.login,
      state: pr.state,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      base_branch: pr.base?.ref,
      head_branch: pr.head?.ref,
    },
    summary: {
      review_comments_count: reviewComments.length,
      issue_comments_count: issueComments.length,
      reviews_count: reviews.length,
    },
    reviews: reviews.map(r => ({
      id: r.id,
      type: "review",
      reviewer: r.user?.login,
      state: r.state, // APPROVED, CHANGES_REQUESTED, COMMENTED
      submitted_at: r.submitted_at,
      body: r.body || "",
      url: r.html_url,
    })).filter(r => r.body), // only include reviews that have a body

    review_comments: reviewComments.map(c => ({
      id: c.id,
      type: "review_comment",
      reviewer: c.user?.login,
      file: c.path,
      line: c.line || c.original_line,
      side: c.side,
      diff_hunk: c.diff_hunk,
      body: c.body,
      created_at: c.created_at,
      updated_at: c.updated_at,
      url: c.html_url,
      in_reply_to_id: c.in_reply_to_id || null,
    })),

    issue_comments: issueComments.map(c => ({
      id: c.id,
      type: "issue_comment",
      author: c.user?.login,
      body: c.body,
      created_at: c.created_at,
      updated_at: c.updated_at,
      url: c.html_url,
    })),
  };

  // ── Write JSON ─────────────────────────────────────────────────────────────
  fs.writeFileSync("pr-comments.json", JSON.stringify(output, null, 2));
  console.log(`✅ Saved pr-comments.json (${reviewComments.length + issueComments.length + output.reviews.length} total comments)`);

  // ── Build Markdown ─────────────────────────────────────────────────────────
  const lines = [];

  lines.push(`# PR #${PR} Comments: ${pr.title || "binG"}`);
  lines.push(`**URL:** ${pr.html_url}`);
  lines.push(`**Author:** @${pr.user?.login} | **State:** ${pr.state}`);
  lines.push(`**Created:** ${formatDate(pr.created_at)}`);
  lines.push(`**Branch:** \`${pr.head?.ref}\` → \`${pr.base?.ref}\``);
  lines.push("");
  lines.push(`---`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push(`- Inline review comments: **${reviewComments.length}**`);
  lines.push(`- General PR comments: **${issueComments.length}**`);
  lines.push(`- Reviews (with body): **${output.reviews.length}**`);
  lines.push("");

  // Group review comments by file
  const byFile = {};
  for (const c of reviewComments) {
    const f = c.file || "(unknown file)";
    if (!byFile[f]) byFile[f] = [];
    byFile[f].push(c);
  }

  if (Object.keys(byFile).length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Inline Review Comments (by file)");
    lines.push("");

    for (const [file, comments] of Object.entries(byFile)) {
      lines.push(`### 📄 \`${file}\``);
      lines.push("");

      // Group top-level comments and replies
      const topLevel = comments.filter(c => !c.in_reply_to_id);
      const replies  = comments.filter(c =>  c.in_reply_to_id);

      for (const c of topLevel) {
        lines.push(`#### Comment by @${c.reviewer} — ${formatDate(c.created_at)}`);
        if (c.line) lines.push(`**Line:** ${c.line} (${c.side || "RIGHT"})`);
        if (c.diff_hunk) {
          lines.push("```diff");
          lines.push(c.diff_hunk);
          lines.push("```");
        }
        lines.push("");
        lines.push(c.body);
        lines.push("");
        lines.push(`[View on GitHub](${c.url})`);
        lines.push("");

        // Replies to this comment
        const threadReplies = replies.filter(r => r.in_reply_to_id === c.id);
        for (const r of threadReplies) {
          lines.push(`> **↩ Reply by @${r.reviewer}** — ${formatDate(r.created_at)}`);
          lines.push(`>`);
          const replyLines = r.body.split("\n").map(l => `> ${l}`);
          lines.push(...replyLines);
          lines.push("");
        }
        lines.push("---");
        lines.push("");
      }
    }
  }

  if (output.reviews.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Review Summaries");
    lines.push("");
    for (const r of output.reviews) {
      lines.push(`### Review by @${r.reviewer} — ${r.state} — ${formatDate(r.submitted_at)}`);
      lines.push("");
      lines.push(r.body);
      lines.push("");
      lines.push(`[View on GitHub](${r.url})`);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  if (issueComments.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## General PR Discussion");
    lines.push("");
    for (const c of issueComments) {
      lines.push(`### @${c.author} — ${formatDate(c.created_at)}`);
      lines.push("");
      lines.push(c.body);
      lines.push("");
      lines.push(`[View on GitHub](${c.url})`);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  fs.writeFileSync("pr-comments.md", lines.join("\n"));
  console.log("✅ Saved pr-comments.md");
  console.log("\nDone! Output files:");
  console.log("  pr-comments.json");
  console.log("  pr-comments.md");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
