import { Octokit } from "@octokit/rest";

const token = process.env.GITHUB_TOKEN;
const repoFull = process.env.GITHUB_REPOSITORY;
const [owner, repo] = repoFull.split("/");

if (!token || !repoFull) {
    console.error("GITHUB_TOKEN and GITHUB_REPOSITORY must be set");
    process.exit(1);
}

const octokit = new Octokit({ auth: token });

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
    PREFIX_ALIASES[`[${lower}]`] = norm;
    PREFIX_ALIASES[lower] = norm;
    PREFIX_ALIASES[`${lower}:`] = norm;
    PREFIX_ALIASES[p] = norm;
    PREFIX_ALIASES[`${p}:`] = norm;
});

function stripPrefix(title) {
    return title.replace(/^\[[^\]]+\]\s*/, "").replace(/^[a-z/]+:\s*/i, "").trim();
}

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

async function fetchAllPRs() {
    const prs = [];
    let page = 1;
    while (true) {
        const { data } = await octokit.pulls.list({
            owner,
            repo,
            state: "closed",
            per_page: 100,
            page,
        });
        if (!data.length) break;
        prs.push(...data);
        page++;
    }
    return prs;
}

async function main() {
    const { data: compare } = await octokit.repos.compareCommits({
        owner,
        repo,
        base: "master",
        head: "dev",
    });

    const devShas = new Set(compare.commits.map(c => c.sha));

    const allPRs = await fetchAllPRs();

    const pendingPRs = [];
    for (const pr of allPRs) {
        const { data: prCommits } = await octokit.pulls.listCommits({
            owner,
            repo,
            pull_number: pr.number
        });

        if (prCommits.some(c => devShas.has(c.sha))) {
            pendingPRs.push(pr);
        }
    }

    if (!pendingPRs.length) {
        console.log("No PRs in dev that are not yet in master.");
        return;
    }

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

    const orderedSections = ["[Task]", ...Object.keys(SECTIONS).filter(k => k !== "[Task]" && k !== "Other"), "Other"];

    let body = "# 🚀 Release Notes\n\n";
    for (const key of orderedSections) {
        const items = sectionGroups[key];
        if (items?.length) {
            body += `## ${SECTIONS[key]}\n${items.join("\n")}\n\n`;
        }
    }

    const { data: releases } = await octokit.repos.listReleases({ owner, repo });
    let draft = releases.find(r => r.draft);

    let nextVersion = "v0.1.0";
    const latest = releases.find(r => !r.draft) || releases[0];
    if (latest) {
        const match = latest.tag_name.match(/v(\d+)\.(\d+)\.(\d+)/);
        if (match) {
            const [_, major, minor, patch] = match.map(Number);
            nextVersion = `v${major}.${minor}.${patch + 1}`;
        }
    }

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
