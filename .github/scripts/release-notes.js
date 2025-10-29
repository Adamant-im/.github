import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import { execSync } from "child_process";

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

const DEV_BRANCH = "dev";
const MASTER_BRANCH = "master";
const { owner: OWNER, repo: REPO } = detectRepo();

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const graphqlWithAuth = graphql.defaults({
    headers: { authorization: `token ${process.env.GITHUB_TOKEN}` },
});

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

// Get linked issues for a PR via GraphQL
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

async function main() {
    // 1️⃣ Get latest release
    let lastRelease = null;
    try {
        const { data } = await octokit.repos.listReleases({ owner: OWNER, repo: REPO, per_page: 1 });
        lastRelease = data[0] || null;
    } catch {}

    const since = lastRelease ? new Date(lastRelease.created_at) : null;

    // 2️⃣ Determine branch
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
    const issueMap = {}; // key: issue number, value: { title, PR numbers }
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

    // 5️⃣ Output
    console.log(`📦 Repository: ${OWNER}/${REPO}`);
    console.log(`📍 Target branch: ${targetBranch}`);
    console.log(`🕓 Last release: ${lastRelease ? lastRelease.tag_name : "none"}`);
    console.log(`\n✅ Issues with linked PRs:\n`);

    for (const [issueNum, info] of Object.entries(issueMap)) {
        console.log(`#${issueNum} ${info.title} ↳ PRs: ${info.prs.map(n => `#${n}`).join(", ")}`);
    }

    if (prsWithoutIssue.length) {
        console.log(`\n✅ PRs without linked issues:\n`);
        for (const pr of prsWithoutIssue) {
            console.log(`#${pr.number} ${pr.title}`);
        }
    }
}

main().catch(err => {
    console.error("Error:", err);
    process.exit(1);
});
