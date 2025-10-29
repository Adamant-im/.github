import { Octokit } from "@octokit/rest";
import { execSync } from "child_process";
import { request } from "@octokit/graphql";

function detectRepo() {
    if (process.env.GITHUB_REPOSITORY) {
        const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
        return { owner, repo };
    }

    try {
        const remoteUrl = execSync("git config --get remote.origin.url").toString().trim();
        const match = remoteUrl.match(/[:/]([^/]+)\/([^/]+)(?:\.git)?$/);
        if (match) {
            return { owner: match[1], repo: match[2] };
        }
    } catch {
        console.warn("⚠️ Could not detect repository from git remote.");
    }

    throw new Error("❌ Repository could not be detected.");
}

const DEV_BRANCH = "dev";
const MASTER_BRANCH = "master";
const { owner: OWNER, repo: REPO } = detectRepo();

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const graphqlWithAuth = request.defaults({
    headers: { authorization: `token ${process.env.GITHUB_TOKEN}` },
});

// === Helper: get all PRs with pagination ===
async function getAllPulls({ owner, repo, base }) {
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

// === Helper: get issues linked to PR via GraphQL ===
async function getLinkedIssues(owner, repo, prNumber) {
    const query = `
    query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          closingIssuesReferences(first: 10) {
            nodes {
              number
              title
              state
              url
            }
          }
        }
      }
    }
  `;

    try {
        const response = await graphqlWithAuth(query, { owner, repo, number: prNumber });
        const issues = response.repository.pullRequest.closingIssuesReferences.nodes || [];
        return issues;
    } catch (err) {
        console.warn(`⚠️ Failed to get linked issues for PR #${prNumber}:`, err.message);
        return [];
    }
}

async function main() {
    // 1️⃣ Get latest release
    let lastRelease = null;
    try {
        const { data } = await octokit.repos.listReleases({
            owner: OWNER,
            repo: REPO,
            per_page: 1,
        });
        lastRelease = data[0] || null;
    } catch {
        console.log("⚠️ Could not fetch releases — maybe none exist yet.");
    }

    const since = lastRelease ? new Date(lastRelease.created_at) : null;

    // 2️⃣ Determine target branch
    const branches = await octokit.repos.listBranches({ owner: OWNER, repo: REPO });
    const branchNames = branches.data.map((b) => b.name);
    let targetBranch = MASTER_BRANCH;

    if (branchNames.includes(DEV_BRANCH) && lastRelease) {
        try {
            const compare = await octokit.repos.compareCommits({
                owner: OWNER,
                repo: REPO,
                base: lastRelease.tag_name,
                head: DEV_BRANCH,
            });
            if (compare.data.commits.length > 0) {
                targetBranch = DEV_BRANCH;
            }
        } catch {
            console.warn("⚠️ Could not compare commits, falling back to master.");
        }
    }

    // 3️⃣ Fetch merged PRs
    const prs = await getAllPulls({ owner: OWNER, repo: REPO, base: targetBranch });
    const mergedPRs = prs.filter(
        (pr) => pr.merged_at && (!since || new Date(pr.merged_at) > since)
    );

    // 4️⃣ Fetch linked issues for each PR
    const result = [];
    for (const pr of mergedPRs) {
        const issues = await getLinkedIssues(OWNER, REPO, pr.number);

        result.push({
            number: pr.number,
            title: pr.title,
            user: pr.user.login,
            merged_at: pr.merged_at,
            url: pr.html_url,
            issues,
        });
    }

    // 5️⃣ Output
    console.log(`📦 Repository: ${OWNER}/${REPO}`);
    console.log(`📍 Target branch: ${targetBranch}`);
    console.log(`🕓 Last release: ${lastRelease ? lastRelease.tag_name : "none"}`);
    console.log(`✅ Found ${result.length} merged PRs:\n`);

    for (const pr of result) {
        console.log(`#${pr.number} ${pr.title} (${pr.user}) — ${pr.merged_at}`);
        if (pr.issues.length) {
            pr.issues.forEach((i) =>
                console.log(`   ↳ #${i.number} ${i.title} (${i.state}) → ${i.url}`)
            );
        } else {
            console.log("   ↳ no linked issues");
        }
        console.log(`→ ${pr.url}\n`);
    }
}

main().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
});
