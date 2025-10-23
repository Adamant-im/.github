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

async function main() {
    // 1. Get latest release (tag) on master
    const { data: releases } = await octokit.repos.listReleases({ owner, repo });
    const latestRelease = releases.find(r => !r.draft);
    const latestTag = latestRelease?.tag_name;

    // 2. Compare dev vs last release tag to get all commits after last release
    const { data: compare } = await octokit.repos.compareCommits({
        owner,
        repo,
        base: latestTag || "master",
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

    // 4. Group PRs by section
    const sectionGroups = {};
    Object.keys(SECTIONS).forEach(k => sectionGroups[k] = []);

    for (const pr of pendingPRs) {
        const prefix = getPrefix(pr.title) || "Other";
        const section = SECTIONS[prefix] ? prefix : "Other";

        const prLine = section === "Other"
            ? `• ${pr.title} (#${pr.number}) by @${pr.user.login}`
            : `• ${prefix} ${stripPrefix(pr.title)} (#${pr.number}) by @${pr.user.login}`;

        sectionGroups[section].push(prLine);
    }

    // 5. Order sections: Tasks first, Other last
    const orderedSections = ["[Task]", ...Object.keys(SECTIONS).filter(k => k !== "[Task]" && k !== "Other"), "Other"];

    let body = "# 🚀 Release Notes\n\n";
    for (const key of orderedSections) {
        const items = sectionGroups[key];
        if (items?.length) {
            body += `## ${SECTIONS[key]}\n${items.join("\n")}\n\n`;
        }
    }

    // 6. Determine next patch version
    let nextVersion = "v0.1.0";
    const latestNonDraft = releases.find(r => !r.draft) || releases[0];
    if (latestNonDraft) {
        const match = latestNonDraft.tag_name.match(/v(\d+)\.(\d+)\.(\d+)/);
        if (match) {
            const [_, major, minor, patch] = match.map(Number);
            nextVersion = `v${major}.${minor}.${patch + 1}`;
        }
    }

    // 7. Create or update draft release
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
