import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";
import { execSync } from "child_process";

dotenv.config();

// === Detect repository info automatically ===
function detectRepo() {
    // 1️⃣ If running inside GitHub Actions
    if (process.env.GITHUB_REPOSITORY) {
        const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
        return { owner, repo };
    }

    // 2️⃣ Otherwise, try reading from local git config
    try {
        const remoteUrl = execSync("git config --get remote.origin.url").toString().trim();
        // Handles both SSH (git@github.com:org/repo.git) and HTTPS (https://github.com/org/repo.git)
        const match = remoteUrl.match(/[:/]([^/]+)\/([^/]+)(?:\.git)?$/);
        if (match) {
            return { owner: match[1], repo: match[2] };
        }
    } catch {
        console.warn("⚠️ Could not detect repository from git remote.");
    }

    throw new Error("❌ Repository could not be detected. Run inside a git repo or set GITHUB_REPOSITORY.");
}

// === Config ===
const DEV_BRANCH = "dev";
const MASTER_BRANCH = "master";
const { owner: OWNER, repo: REPO } = detectRepo();

// === Init GitHub API client ===
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

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
        console.log("⚠️ Could not fetch releases — maybe there are none yet.");
    }

    const since = lastRelease ? new Date(lastRelease.created_at) : null;

    // 2️⃣ Determine which branch to compare
    const branches = await octokit.repos.listBranches({ owner: OWNER, repo: REPO });
    const branchNames = branches.data.map((b) => b.name);

    let targetBranch = MASTER_BRANCH;

    // If `dev` exists and has commits after the last release → use it
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
            console.warn("⚠️ Failed to compare commits, falling back to master.");
        }
    }

    // 3️⃣ Fetch closed PRs for the selected branch
    const { data: prs } = await octokit.pulls.list({
        owner: OWNER,
        repo: REPO,
        state: "closed",
        base: targetBranch,
        per_page: 100,
    });

    // 4️⃣ Filter PRs that are merged and newer than the last release
    const mergedPRs = prs.filter(
        (pr) => pr.merged_at && (!since || new Date(pr.merged_at) > since)
    );

    // 5️⃣ Output
    console.log(`📦 Repository: ${OWNER}/${REPO}`);
    console.log(`📍 Target branch: ${targetBranch}`);
    console.log(`🕓 Last release: ${lastRelease ? lastRelease.tag_name : "none"}`);
    console.log(`✅ Found ${mergedPRs.length} merged PRs:\n`);

    mergedPRs.forEach((pr) => {
        console.log(`#${pr.number} ${pr.title} (${pr.user.login}) — ${pr.merged_at}`);
        console.log(`→ ${pr.html_url}\n`);
    });
}

main().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
});
