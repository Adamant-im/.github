import { Octokit } from "@octokit/rest";

const token = process.env.GITHUB_TOKEN;
const repoFull = process.env.GITHUB_REPOSITORY;
const [owner, repo] = repoFull.split("/");

if (!token || !repoFull) {
    console.error("GITHUB_TOKEN and GITHUB_REPOSITORY must be set");
    process.exit(1);
}

const octokit = new Octokit({ auth: token });

// Section definitions and prefixes
const SECTIONS = {
    "[Task]": "🚀 Tasks",
    "[Composite]": "🚀 Tasks",
    "[Feat]": "✨ New Features",
    "[Enhancement]": "🔧 Enhancements",
    "[UX/UI]": "🔧 Enhancements",
    "[Bug]": "🐞 Bug Fixes",
    "[Refactor]": "♻️ Refactoring",
    "[Docs]": "📚 Documentation",
    "[Test]": "🧪 Tests",
    "[Chore]": "🧹 Chores",
    Other: "📦 Other",
};

const PREFIXES = Object.keys(SECTIONS).filter(p => p !== "Other");

// Build prefix aliases (lowercase, colon, brackets)
const PREFIX_ALIASES = {};
PREFIXES.forEach(p => {
    const clean = p.replace(/[\[\]]/g, "");
    PREFIX_ALIASES[clean.toLowerCase()] = p;
    PREFIX_ALIASES[`${clean.toLowerCase()}:`] = p;
    PREFIX_ALIASES[clean] = p;
    PREFIX_ALIASES[`${clean}:`] = p;
});

// Strip prefix from title
function stripPrefix(title) {
    return title.replace(/^\[[^\]]+\]\s*/, "").replace(/^[a-z🎨\/]+:\s*/i, "").trim();
}

// Extract normalized prefix from title
function getPrefix(title) {
    if (!title) return null;
    const match = title.match(/^(\[[^\]]+\]|[a-z🎨\/]+):?/i);
    if (match) {
        const candidate = match[1].replace(/[\[\]]/g, "").toLowerCase();
        return PREFIX_ALIASES[candidate] || "Other";
    }
    return "Other";
}

async function main() {
    // 1. Get latest release on master
    const { data: releases } = await octokit.repos.listReleases({ owner, repo });
    const latestRelease = releases.find(r => !r.draft);
    const latestTag = latestRelease?.tag_name || "master";

    // 2. Compare dev vs latest release to get commits
    const { data: compare } = await octokit.repos.compareCommits({
        owner,
        repo,
        base: latestTag,
        head: "dev",
    });

    const devShas = compare.commits.map(c => c.sha);

    // 3. Find all merged PRs in dev not in master
    const pendingPRs = [];
    for (const sha of devShas) {
        const { data: prs } = await octokit.repos.listPullRequestsAssociatedWithCommit({
            owner,
            repo,
            commit_sha: sha,
        });
        prs.forEach(pr => {
            if (pr.merged_at && !pendingPRs.some(p => p.number === pr.number)) {
                pendingPRs.push(pr);
            }
        });
    }

    if (!pendingPRs.length) {
        console.log("No merged PRs in dev after last release found.");
        return;
    }

    // 4. Map issues → PRs
    const issueMap = new Map(); // issueNumber -> { issue, prs[] }

    for (const pr of pendingPRs) {
        // Fetch issues linked to this PR
        const { data: linkedIssues } = await octokit.pulls.listIssuesAssociatedWithPullRequest({
            owner,
            repo,
            pull_number: pr.number,
        });

        if (linkedIssues.length) {
            linkedIssues.forEach(issue => {
                if (!issueMap.has(issue.number)) {
                    issueMap.set(issue.number, { issue, prs: [] });
                }
                issueMap.get(issue.number).prs.push(pr);
            });
        } else {
            // PR without linked issue → special case
            issueMap.set(`pr-${pr.number}`, { prs: [pr], isStandalone: true });
        }
    }

    // 5. Group PRs/issues by section
    const sectionGroups = {};
    Object.keys(SECTIONS).forEach(k => sectionGroups[k] = []);

    for (const [key, entry] of issueMap.entries()) {
        if (entry.isStandalone) {
            const pr = entry.prs[0];
            const prefix = getPrefix(pr.title);
            const section = SECTIONS[prefix] ? prefix : "Other";
            sectionGroups[section].push(`• ${prefix} ${stripPrefix(pr.title)} (#${pr.number}) by @${pr.user.login}`);
        } else {
            const issue = entry.issue;
            const prefix = getPrefix(issue.title) || getPrefix(entry.prs[0]?.title) || "Other";
            const section = SECTIONS[prefix] ? prefix : "Other";

            const prRefs = entry.prs.map(pr => `#${pr.number} by @${pr.user.login}`).join(", ");
            const issueLine = entry.prs.length > 0
                ? `• ${prefix} ${stripPrefix(issue.title)} (#${issue.number})\n  ↳ PRs: ${prRefs}`
                : `• ${prefix} ${stripPrefix(issue.title)} (#${issue.number})`;

            sectionGroups[section].push(issueLine);
        }
    }

    // 6. Build release notes
    const orderedSections = ["[Task]", ...Object.keys(SECTIONS).filter(k => k !== "[Task]" && k !== "Other"), "Other"];
    let body = "# 🚀 Release Notes\n\n";

    for (const key of orderedSections) {
        const items = sectionGroups[key];
        if (items?.length) {
            body += `## ${SECTIONS[key]}\n${items.join("\n")}\n\n`;
        }
    }

    // 7. Determine next patch version
    let nextVersion = "v0.1.0";
    const latestNonDraft = releases.find(r => !r.draft) || releases[0];
    if (latestNonDraft) {
        const match = latestNonDraft.tag_name.match(/v(\d+)\.(\d+)\.(\d+)/);
        if (match) {
            const [_, major, minor, patch] = match.map(Number);
            nextVersion = `v${major}.${minor}.${patch + 1}`;
        }
    }

    // 8. Create or update draft release
    const draft = releases.find(r => r.draft);
    if (draft) {
        console.log("Updating existing draft release:", draft.tag_name);
        await octokit.repos.updateRelease({
            owner,
            repo,
            release_id: draft.id,
            name: nextVersion,
            body,
        });
    } else {
        console.log("Creating new draft release");
        await octokit.repos.createRelease({
            owner,
            repo,
            tag_name: nextVersion,
            name: nextVersion,
            body,
            draft: true,
        });
    }

    console.log("✅ Draft release updated successfully");
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
