import { Octokit } from "@octokit/rest";

const token = process.env.GITHUB_TOKEN;
const repoFull = process.env.GITHUB_REPOSITORY;
const [owner, repo] = repoFull.split("/");

if (!token || !repoFull) {
    console.error("GITHUB_TOKEN and GITHUB_REPOSITORY must be set");
    process.exit(1);
}

const octokit = new Octokit({ auth: token });

// Sections definitions
const SECTIONS = {
    "🚀 Tasks": ["Task", "Composite"],
    "✨ New Features": ["Feat"],
    "🔧 Enhancements": ["Enhancement", "UX/UI"],
    "🐞 Bug Fixes": ["Bug"],
    "♻️ Refactoring": ["Refactor"],
    "📚 Documentation": ["Docs"],
    "🧪 Tests": ["Test"],
    "🧹 Chores": ["Chore"],
    "📦 Other": ["Other"],
};

// Normalize prefixes for PR titles
const PREFIX_ALIASES = {};
Object.keys(SECTIONS).forEach(section => {
    SECTIONS[section].forEach(p => {
        const lower = p.toLowerCase();
        PREFIX_ALIASES[p] = section;
        PREFIX_ALIASES[lower] = section;
        PREFIX_ALIASES[`${p}:`] = section;
        PREFIX_ALIASES[`${lower}:`] = section;
        PREFIX_ALIASES[`[${p}]`] = section;
        PREFIX_ALIASES[`[${lower}]`] = section;
    });
});

function stripPrefix(title) {
    return title.replace(/^\[[^\]]+\]\s*/, "").replace(/^[a-z/]+:\s*/i, "").trim();
}

function getSectionFromPRTitle(title) {
    if (!title) return "📦 Other";
    const matchBracket = title.match(/^\[([^\]]+)\]/);
    if (matchBracket && PREFIX_ALIASES[`[${matchBracket[1].toLowerCase()}]`]) {
        return PREFIX_ALIASES[`[${matchBracket[1].toLowerCase()}]`];
    }
    const matchWord = title.match(/^([a-z/]+):?/i);
    if (matchWord && PREFIX_ALIASES[matchWord[1].toLowerCase()]) {
        return PREFIX_ALIASES[matchWord[1].toLowerCase()];
    }
    return "📦 Other";
}

async function main() {
    // 1. Get latest release tag on master
    const { data: releases } = await octokit.repos.listReleases({ owner, repo });
    const latestRelease = releases.find(r => !r.draft);
    const latestTag = latestRelease?.tag_name || "master";

    // 2. Compare dev vs last release tag
    const { data: compare } = await octokit.repos.compareCommits({
        owner,
        repo,
        base: latestTag,
        head: "dev",
    });

    const devShas = compare.commits.map(c => c.sha);

    // 3. Find merged PRs associated with these commits
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

    // 4. Build issue map from linked issues
    const issueMap = new Map();

    for (const pr of pendingPRs) {
        // Get issues linked to PR
        const { data: linkedIssues } = await octokit.rest.pulls.listIssuesAssociatedWithPullRequest({
            owner,
            repo,
            pull_number: pr.number,
        });

        if (linkedIssues.length) {
            for (const issue of linkedIssues) {
                if (!issueMap.has(issue.number)) issueMap.set(issue.number, { ...issue, prs: [] });
                issueMap.get(issue.number).prs.push(pr);
            }
        } else {
            // PR without issue
            const key = `pr-${pr.number}`;
            issueMap.set(key, { title: pr.title, prs: [pr], isStandalone: true });
        }
    }

    // 5. Group by sections
    const sectionGroups = {};
    Object.values(SECTIONS).forEach(sec => sectionGroups[sec[0]] = []);
    sectionGroups["📦 Other"] = [];

    for (const issue of issueMap.values()) {
        if (issue.isStandalone) {
            const pr = issue.prs[0];
            const section = getSectionFromPRTitle(pr.title);
            const line = `• ${stripPrefix(pr.title)} (#${pr.number}) by @${pr.user.login}`;
            sectionGroups[section].push(line);
        } else {
            // Issue with PRs
            const issuePrefix = getSectionFromPRTitle(issue.title);
            const prRefs = issue.prs.map(pr => `#${pr.number} by @${pr.user.login}`).join(", ");
            const line = `• ${stripPrefix(issue.title)} (#${issue.number})\n  ↳ PRs: ${prRefs}`;
            sectionGroups[issuePrefix].push(line);
        }
    }

    // 6. Order sections: Tasks first, Other last
    const orderedSections = ["🚀 Tasks", "✨ New Features", "🔧 Enhancements", "🐞 Bug Fixes", "♻️ Refactoring", "📚 Documentation", "🧪 Tests", "🧹 Chores", "📦 Other"];

    let body = "# 🚀 Release Notes\n\n";
    for (const key of orderedSections) {
        const items = sectionGroups[key];
        if (items?.length) body += `## ${key}\n${items.join("\n")}\n\n`;
    }

    // 7. Determine next patch version
    let nextVersion = "v0.1.0";
    if (latestRelease) {
        const match = latestRelease.tag_name.match(/v(\d+)\.(\d+)\.(\d+)/);
        if (match) {
            const [_, major, minor, patch] = match.map(Number);
            nextVersion = `v${major}.${minor}.${patch + 1}`;
        }
    }

    // 8. Create/update draft release
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
