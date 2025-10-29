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

// --- Classify title by flexible prefix ---
function classifyTitle(title) {
    const cleaned = title.replace(/^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]+/u, '');

    const match = cleaned.match(/^\s*(?:\[([^\]]+)\]|([^\s:]+))\s*:?\s*/i);
    const rawPrefix = match ? (match[1] || match[2]) : null;
    if (!rawPrefix) return "Other";

    const prefix = rawPrefix.toLowerCase();

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

    return map[prefix] || "Other";
}



// --- Main function ---
async function main() {
    // 1️⃣ Latest release
    let lastRelease = null;
    try {
        const { data } = await octokit.repos.listReleases({ owner: OWNER, repo: REPO, per_page: 1 });
        lastRelease = data[0] || null;
    } catch {}

    const since = lastRelease ? new Date(lastRelease.created_at) : null;

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

    // 3️⃣ Fetch merged PRs
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

    // 5️⃣ Classify
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
        sections[section].push(
            `#${num} ${info.title} ↳ PRs: ${info.prs
                .sort((a, b) => a - b) // сортировка по возрастанию
                .map(n => `#${n}`)
                .join(", ")}`
        );
    }

    for (const pr of prsWithoutIssue) {
        const section = classifyTitle(pr.title);
        sections[section].push(`#${pr.number} ${pr.title}`);
    }

    // 6️⃣ Print release notes
    console.log(`## Draft Release Notes\n`);
    for (const [sectionName, items] of Object.entries(sections)) {
        if (!items.length) continue;
        console.log(`### ${sectionName}\n`);
        items.forEach(i => console.log(`- ${i}`));
        console.log(""); // blank line
    }
}

// --- Run ---
main().catch(err => {
    console.error("Error:", err);
    process.exit(1);
});
