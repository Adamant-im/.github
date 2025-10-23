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

const PREFIXES = [
    "Task", "Composite", "Feat", "Enhancement", "UX/UI",
    "Bug", "Refactor", "Docs", "Test", "Chore", "Fix"
];

const PREFIX_ALIASES = {};
PREFIXES.forEach(p => {
    const norm = `[${p}]`;
    const lower = p.toLowerCase();

    // Bracket variants
    PREFIX_ALIASES[`[${lower}]`] = norm;
    PREFIX_ALIASES[`[${p}]`] = norm;

    // Plain word variants
    PREFIX_ALIASES[lower] = norm;
    PREFIX_ALIASES[p] = norm;

    // Colon variants
    PREFIX_ALIASES[`${lower}:`] = norm;
    PREFIX_ALIASES[`${p}:`] = norm;
});

// Strip prefix from title
function stripPrefix(title) {
    return title.replace(/^\[[^\]]+\]\s*/, "").replace(/^[a-z/]+:\s*/i, "").trim();
}

// Extract normalized prefix from title
function getPrefix(title) {
    if (!title) return null;
    const matchBracket = title.match(/^\[([^\]]+)\]/);
    if (matchBracket) {
        const norm = PREFIX_ALIASES[`[${matchBracket[1].toLowerCase()}]`];
        if (norm) return norm;
    }
    const matchWord = title.match(/^([a-z/]+):/i);
    if (matchWord) {
        const norm = PREFIX_ALIASES[matchWord[1].toLowerCase()];
        if (norm) return norm;
    }
    return null;
}

// Extract issue numbers from PR body
function extractIssueNumbers(prBody) {
    if (!prBody) return [];
    return Array.from(prBody.matchAll(/#(\d+)/g), m => parseInt(m[1], 10));
}

async function main() {
    // 1. Get latest release (tag) on master
    const { data: releases } = await octokit.repos.listReleases({ owner, repo });
    const latestRelease = releases.find(r => !r.draft);
    const latestTag = latestRelease?.tag_name || "master";

    // 2. Compare dev vs last release tag to get all commits after last release
    const { data: compare } = await octokit.repos.compareCommits({
        owner,
        repo,
        base: latestTag,
        head: "dev",
    });

    const devShas = compare.commits.map(c => c.sha);

    // 3. Find PRs associated with these commits
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

    // 4. Map issues to PRs
    const issueMap = new Map();
    const standalonePRs = [];

    for (const pr of pendingPRs) {
        const issueNumbers = extractIssueNumbers(pr.body);
        if (issueNumbers.length) {
            for (const num of issueNumbers) {
                const { data: issue } = await octokit.issues.get({ owner, repo, issue_number: num });
                if (!issueMap.has(issue.number)) issueMap.set(issue.number, { issue, prs: [] });
                issueMap.get(issue.number).prs.push(pr);
            }
        } else {
            standalonePRs.push(pr);
        }
    }

    // 5. Group by sections
    const sectionGroups = {};
    Object.keys(SECTIONS).forEach(k => sectionGroups[k] = []);

    for (const [issueNum, obj] of issueMap.entries()) {
        const issue = obj.issue;
        const prs = obj.prs;
        const prefix = getPrefix(issue.title) || getPrefix(prs[0]?.title) || "Other";
        const section = SECTIONS[prefix] ? prefix : "Other";
        const prAuthors = prs.map(p => `@${p.user.login}`).join(", ");
        const prRefs = prs.map(p => `#${p.number}`).join(", ");

        const line = prs.length > 0
            ? `• ${prefix} ${stripPrefix(issue.title)} (#${issue.number})\n  ↳ PRs: ${prRefs} by ${prAuthors}`
            : `• ${prefix} ${stripPrefix(issue.title)} (#${issue.number})`;

        sectionGroups[section].push(line);
    }

    // Special case: PRs without issues
    for (const pr of standalonePRs) {
        const prefix = getPrefix(pr.title) || "Other";
        const section = SECTIONS[prefix] ? prefix : "Other";
        const line = section === "Other"
            ? `• ${pr.title} (#${pr.number}) by @${pr.user.login}`
            : `• ${prefix} ${stripPrefix(pr.title)} (#${pr.number}) by @${pr.user.login}`;
        sectionGroups[section].push(line);
    }

    // 6. Order sections: Tasks first, Other last
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
