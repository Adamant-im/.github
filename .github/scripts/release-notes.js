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

// --- Determine section from prefix ---
function classifyTitle(title) {
    const cleaned = title.replace(/^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]+/u, "").trim();
    const match = cleaned.match(/^\s*\[([^\]]+)\]|^\s*([^\s:]+)\s*:?\s*/i);
    if (!match) return "Other";

    const rawPrefix = (match[1] || match[2] || "").split(",")[0].trim().toLowerCase();

    const map = {
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

    return map[rawPrefix] || "Other";
}

// --- Normalize title, preserving multiple prefixes ---
function normalizeTitlePrefixes(title) {
    let cleaned = title.trim();

    // Extract prefix part if exists
    const match = cleaned.match(/^\s*(?:\[([^\]]+)\]|([^\s:]+))\s*:?\s*/i);
    if (match) {
        let prefixText = match[1] || match[2] || "";
        // Keep multiple prefixes intact (e.g. "Feat, UX/UI")
        const formatted = `[${prefixText
            .split(",")
            .map(p => p.trim().replace(/^[\[\]]+/g, "").replace(/^([a-z])/, (_, c) => c.toUpperCase()))
            .join(", ")}]`;
        cleaned = cleaned.replace(match[0], `${formatted} `);
    }

    return cleaned;
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
    // 1️⃣ Get last release
    let lastRelease = null;
    try {
        const { data } = await octokit.repos.listReleases({ owner: OWNER, repo: REPO, per_page: 20 });
        const published = data.filter(r => !r.draft);
        lastRelease = published.length ? published[0] : null;
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

    // 3️⃣ Merged PRs since last release
    const prs = await getAllPRs({ owner: OWNER, repo: REPO, base: targetBranch });
    const mergedPRs = prs.filter(pr => pr.merged_at && (!since || new Date(pr.merged_at) > since));

    // 4️⃣ Build issue → PR map
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

    // 5️⃣ Group by section
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

    // 6️⃣ Build release notes
    let releaseNotesText = `## Draft Release Notes\n\n`;
    for (const [sectionName, items] of Object.entries(sections)) {
        if (!items.length) continue;
        items.sort((a, b) => parseInt(a.match(/#(\d+)/)[1]) - parseInt(b.match(/#(\d+)/)[1]));
        releaseNotesText += `### ${sectionName}\n`;
        items.forEach(i => (releaseNotesText += `- ${i}\n`));
        releaseNotesText += `\n`;
    }

    console.log(releaseNotesText);

    // 7️⃣ Update or create draft release
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

    console.log("✅ Release processing completed");
}

main().catch(err => {
    console.error("Error:", err);
    process.exit(1);
});
