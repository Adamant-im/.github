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

// --- Known prefixes map ---
const PREFIX_MAP = {
    bug: "🐞 Bug Fixes",
    feat: "✨ New Features",
    enhancement: "🔧 Enhancements",
    refactor: "🛠 Refactoring",
    docs: "📚 Documentation",
    test: "✅ Tests",
    chore: "⚙️ Chores",
    task: "🚀 Tasks",
    composite: "🚀 Tasks",
    "ux/ui": "🔧 Enhancements",
    proposal: "💡 Ideas & Proposals",
    idea: "💡 Ideas & Proposals",
    discussion: "💡 Ideas & Proposals",
};

// --- Helper to capitalize prefix cleanly ---
function capitalizePrefix(prefix) {
    return prefix
        .toLowerCase()
        .split("/")
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join("/");
}

// --- Extract and normalize all prefixes in title (merged into one [..] if multiple) ---
function extractAndNormalizePrefixes(title) {
    const matches = [...title.matchAll(/\[([^\]]+)\]/g)];
    if (matches.length) {
        const combined = matches
            .map(m => m[1].split(',').map(p => p.trim()).filter(Boolean).map(capitalizePrefix))
            .flat();
        return {
            prefix: `[${combined.join(', ')}]`,
            cleanTitle: title.replace(/^(\s*\[[^\]]+\]\s*)+/, '').trim(),
        };
    }

    const singleMatch = title.match(
        /^([^\w]*)(bug|feat|enhancement|refactor|docs|test|chore|task|composite|ux\/ui|proposal|idea|discussion)[:\-\s]/i
    );
    if (singleMatch) {
        const normalized = capitalizePrefix(singleMatch[2]);
        return { prefix: `[${normalized}]`, cleanTitle: title.replace(singleMatch[0], '').trim() };
    }

    return { prefix: '', cleanTitle: title };
}

// --- Normalize title ---
function normalizeTitlePrefixes(title) {
    const { prefix, cleanTitle } = extractAndNormalizePrefixes(title);
    return prefix ? `${prefix} ${cleanTitle}` : cleanTitle;
}

// --- Classify title ---
function classifyTitle(title) {
    const { prefix } = extractAndNormalizePrefixes(title);
    if (!prefix) return "Other";

    // Берём первый префикс для классификации
    const firstPrefix = prefix.split(',')[0].replace(/[\[\]]/g, '').toLowerCase();
    return PREFIX_MAP[firstPrefix] || "Other";
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

// --- Main function ---
async function main() {
    let lastRelease = null;
    try {
        const { data } = await octokit.repos.listReleases({ owner: OWNER, repo: REPO, per_page: 20 });
        const publishedReleases = data.filter(r => !r.draft);
        lastRelease = publishedReleases.length ? publishedReleases[0] : null;
    } catch {}

    const since = lastRelease ? new Date(lastRelease.created_at) : null;
    const lastTag = lastRelease?.tag_name || null;
    const newTag = nextVersion(lastTag);

    // 2️⃣ Target branch
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

    // Sections
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

    for (const [num, info] of Object.entries(issueMap)) {
        const section = classifyTitle(info.title);
        const title = normalizeTitlePrefixes(info.title);
        const prsText = info.prs.sort((a, b) => a - b).map(n => `#${n}`).join(", ");
        sections[section].push(`#${num} ${title}\n↳ PRs: ${prsText}`);
    }

    for (const pr of prsWithoutIssue) {
        const section = classifyTitle(pr.title);
        const title = normalizeTitlePrefixes(pr.title);
        sections[section].push(`#${pr.number} ${title}`);
    }

    let releaseNotesText = `## Draft Release Notes\n\n`;
    for (const [sectionName, items] of Object.entries(sections)) {
        if (!items.length) continue;
        items.sort((a, b) => parseInt(a.match(/#(\d+)/)[1]) - parseInt(b.match(/#(\d+)/)[1]));
        releaseNotesText += `### ${sectionName}\n`;
        items.forEach(i => releaseNotesText += `- ${i}\n`);
        releaseNotesText += `\n`;
    }

    console.log(releaseNotesText);

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

// --- Run ---
main().catch(err => {
    console.error("Error:", err);
    process.exit(1);
});
