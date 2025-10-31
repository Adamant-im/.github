import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import { execSync } from "child_process";

// --- Detect repository ---
function detectRepo() {
    if (process.env.GITHUB_REPOSITORY) {
        const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
        return { owner, repo };
    }
    try {
        const remoteUrl = execSync("git config --get remote.origin.url").toString().trim();
        const match = remoteUrl.match(/[:/]([^/]+)\/([^/]+)(?:\.git)?$/);
        if (match) return { owner: match[1], repo: match[2] };
    } catch {}
    throw new Error("❌ Repository could not be detected.");
}

// --- Config ---
const DEV_BRANCH = "dev";
const MASTER_BRANCH = "master";
const { owner: OWNER, repo: REPO } = detectRepo();

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const graphqlWithAuth = graphql.defaults({
    headers: { authorization: `token ${process.env.GITHUB_TOKEN}` },
});

// --- Prefix map for classification ---
const PREFIX_MAP = {
    "task": "🚀 Tasks",
    "composite": "🚀 Tasks",
    "ux/ui": "🔧 Enhancements",
    "enhancement": "🔧 Enhancements",
    "bug": "🐞 Bug Fixes",
    "feat": "✨ New Features",
    "refactor": "🛠 Refactoring",
    "docs": "📚 Documentation",
    "test": "✅ Tests",
    "chore": "⚙️ Chores",
    "proposal": "💡 Ideas & Proposals",
    "idea": "💡 Ideas & Proposals",
    "discussion": "💡 Ideas & Proposals",
};

// --- Remove leading emojis (Unicode + :emoji:) ---
function stripLeadingEmoji(title) {
    let t = title.trim();
    // Remove :emoji: at start
    t = t.replace(/^(:[a-zA-Z0-9_+-]+:)+\s*/g, '');
    // Remove actual Unicode emojis
    t = t.replace(/^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]+/u, '');
    return t.trim();
}

// --- Classify title by first prefix ---
function classifyTitle(title) {
    const t = stripLeadingEmoji(title);

    // Bracket prefix [Feat], [Feat, UX/UI], etc.
    let match = t.match(/^\[([^\]]+)\]/);
    if (match) {
        const firstPrefix = match[1].split(',')[0].trim().toLowerCase();
        return PREFIX_MAP[firstPrefix] || "Other";
    }

    // Single-word prefix like chore:, feat:
    match = t.match(/^(bug|feat|enhancement|refactor|docs|test|chore|task|composite|ux\/ui)[:\s-]+/i);
    if (match) {
        const prefix = match[1].toLowerCase();
        return PREFIX_MAP[prefix] || "Other";
    }

    return "Other";
}

// --- Normalize title for release notes ---
// Convert emoji + chore: → [Chore], feat: → [Feat], etc.
function normalizeTitleForNotes(title) {
    let t = title.trim();

    // Remove leading emoji or :emoji: (one or more)
    t = t.replace(/^([\s\p{Emoji_Presentation}\p{Extended_Pictographic}]+|(:[a-zA-Z0-9_+-]+:)+)\s*/u, '');

    // Match bracket prefix like [Feat, Enhancement]
    const match = t.match(/^\[([^\]]+)\]/);
    if (match) {
        // Take only the first prefix
        const firstPrefix = match[1].split(',')[0].trim();
        // Keep the rest of the title unchanged
        t = `[${firstPrefix}]` + t.slice(match[0].length);
        return t;
    }

    // Match single-word prefix like chore:, feat:, etc.
    const match2 = t.match(/^(bug|feat|enhancement|refactor|docs|test|chore|task|composite|ux\/ui)[:\s-]+/i);
    if (match2) {
        const prefix = match2[1].toLowerCase();
        t = t.replace(match2[0], `[${prefix.charAt(0).toUpperCase() + prefix.slice(1)}] `);
    }

    return t;
}



// --- Fetch all closed PRs ---
async function getAllPRs({ owner, repo, base }) {
    const perPage = 100;
    let page = 1;
    let all = [];
    while (true) {
        const { data } = await octokit.pulls.list({
            owner,
            repo,
            state: "closed",
            base,
            per_page: perPage,
            page,
        });
        if (!data.length) break;
        all = all.concat(data);
        if (data.length < perPage) break;
        page++;
    }
    return all;
}

// --- Get linked issues via GraphQL ---
async function getLinkedIssues(prNumber) {
    const query = `
    query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          closingIssuesReferences(first: 10) {
            nodes {
              number
              title
            }
          }
        }
      }
    }
  `;
    try {
        const response = await graphqlWithAuth(query, { owner: OWNER, repo: REPO, number: prNumber });
        return response.repository.pullRequest.closingIssuesReferences.nodes.map(i => ({
            number: i.number,
            title: i.title,
        }));
    } catch {
        return [];
    }
}

// --- Semantic versioning ---
function nextVersion(lastTag) {
    if (!lastTag) return "v0.1.0";
    const match = lastTag.match(/^v(\d+)\.(\d+)\.(\d+)/);
    if (!match) return "v0.1.0";
    let [, major, minor, patch] = match.map(Number);
    patch += 1;
    return `v${major}.${minor}.${patch}`;
}

// --- Main ---
async function main() {
    // Latest non-draft release
    let lastRelease = null;
    try {
        const { data } = await octokit.repos.listReleases({ owner: OWNER, repo: REPO, per_page: 20 });
        const published = data.filter(r => !r.draft);
        lastRelease = published.length ? published[0] : null;
    } catch {}

    const since = lastRelease ? new Date(lastRelease.created_at) : null;
    const lastTag = lastRelease?.tag_name || null;
    const newTag = nextVersion(lastTag);

    // Determine target branch
    const branches = await octokit.repos.listBranches({ owner: OWNER, repo: REPO });
    const branchNames = branches.data.map(b => b.name);
    let targetBranch = MASTER_BRANCH;
    if (branchNames.includes(DEV_BRANCH) && lastRelease) {
        try {
            const compare = await octokit.repos.compareCommits({
                owner: OWNER,
                repo: REPO,
                base: lastRelease.tag_name,
                head: DEV_BRANCH,
            });
            if (compare.data.commits.length > 0) targetBranch = DEV_BRANCH;
        } catch {}
    }

    // Fetch merged PRs
    const prs = await getAllPRs({ owner: OWNER, repo: REPO, base: targetBranch });
    const mergedPRs = prs.filter(pr => pr.merged_at && (!since || new Date(pr.merged_at) > since));

    // Build issue → PR map
    const issueMap = {};
    const prsWithoutIssue = [];

    for (const pr of mergedPRs) {
        const linkedIssues = await getLinkedIssues(pr.number);
        if (linkedIssues.length) {
            for (const issue of linkedIssues) {
                if (!issueMap[issue.number]) issueMap[issue.number] = { title: issue.title, prs: [] };
                issueMap[issue.number].prs.push(pr.number);
            }
        } else {
            prsWithoutIssue.push(pr);
        }
    }

    // Build sections
    const sections = {
        "🚀 Tasks": [],
        "🔧 Enhancements": [],
        "🐞 Bug Fixes": [],
        "✨ New Features": [],
        "🛠 Refactoring": [],
        "📚 Documentation": [],
        "✅ Tests": [],
        "⚙️ Chores": [],
        "💡 Ideas & Proposals": [],
        Other: [],
    };

    // PRs linked to issues
    for (const [num, info] of Object.entries(issueMap)) {
        const section = classifyTitle(info.title);
        const title = info.title; // keep original with all prefixes
        const prsText = info.prs.sort((a, b) => a - b).map(n => `#${n}`).join(", ");
        sections[section].push(`#${num} ${title}\n↳ PRs: ${prsText}`);
    }

    // PRs without issues
    for (const pr of prsWithoutIssue) {
        const title = normalizeTitleForNotes(pr.title);
        const section = classifyTitle(title);
        sections[section].push(`#${pr.number} ${title}`);
    }

    // Build release notes
    let releaseNotesText = `## Draft Release Notes\n\n`;
    for (const [sectionName, items] of Object.entries(sections)) {
        if (!items.length) continue;
        items.sort((a, b) => parseInt(a.match(/#(\d+)/)[1]) - parseInt(b.match(/#(\d+)/)[1]));
        releaseNotesText += `### ${sectionName}\n`;
        items.forEach(i => releaseNotesText += `- ${i}\n`);
        releaseNotesText += `\n`;
    }

    console.log(releaseNotesText);

    // Find or create draft release
    let draftRelease = null;
    try {
        const { data: releases } = await octokit.repos.listReleases({ owner: OWNER, repo: REPO, per_page: 10 });
        draftRelease = releases.find(r => r.draft);
    } catch {}

    if (draftRelease) {
        await octokit.repos.updateRelease({
            owner: OWNER,
            repo: REPO,
            release_id: draftRelease.id,
            body: releaseNotesText,
            name: `Release ${draftRelease.tag_name}`,
        });
        console.log(`✅ Draft release updated: ${draftRelease.tag_name}`);
    } else {
        await octokit.repos.createRelease({
            owner: OWNER,
            repo: REPO,
            tag_name: newTag,
            name: `Release ${newTag}`,
            body: releaseNotesText,
            draft: true,
            prerelease: false,
        });
        console.log(`✅ Draft release created: ${newTag}`);
    }

    console.log(`✅ Release processing completed`);
}

// Run
main().catch(err => {
    console.error("Error:", err);
    process.exit(1);
});
