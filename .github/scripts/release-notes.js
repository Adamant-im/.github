import { Octokit } from "@octokit/rest";

const token = process.env.GITHUB_TOKEN;
const repoFull = process.env.GITHUB_REPOSITORY;
const [owner, repo] = repoFull.split("/");

if (!token || !repoFull) {
    console.error("GITHUB_TOKEN and GITHUB_REPOSITORY must be set");
    process.exit(1);
}

const octokit = new Octokit({ auth: token });

const SECTIONS = [
    { title: "🚀 Tasks", keys: ["Task", "Composite"], labels: ["task", "composite"] },
    { title: "✨ New Features", keys: ["Feat", "Feature"], labels: ["feature", "new-feature"] },
    { title: "🔧 Enhancements", keys: ["Enhancement", "UX/UI"], labels: ["enhancement", "ux/ui"] },
    { title: "🐞 Bug Fixes", keys: ["Bug", "Fix"], labels: ["bug"] },
    { title: "♻️ Refactoring", keys: ["Refactor"], labels: ["refactor"] },
    { title: "📚 Documentation", keys: ["Docs"], labels: ["docs", "documentation"] },
    { title: "🧪 Tests", keys: ["Test"], labels: ["test"] },
    { title: "🧹 Chores", keys: ["Chore"], labels: ["chore", "maintenance"] },
];

function variantsOf(key) {
    const k = key.toLowerCase();
    return [
        k,
        `[${k}]`,
        `${k}:`,
        `[${k}:]`,
        `[${k},`,
        `${k},`,
    ];
}

function parsePrefixes(title) {
    const match = title.match(/(\[[^\]]+\]|^[a-z0-9 ,/:-]+)/gi);
    if (!match) return [];
    return match
        .map(p => p.replace(/[\[\]:]/g, "").trim().toLowerCase().split(/[ ,/]+/))
        .flat()
        .filter(Boolean);
}

function findSection(title, labels = [], issueTitle = "", issueLabels = []) {
    const prefixes = [
        ...parsePrefixes(title),
        ...parsePrefixes(issueTitle),
    ];
    const allLabels = [...(labels || []), ...(issueLabels || [])].map(l => l.toLowerCase());

    for (const section of SECTIONS) {
        const allKeys = section.keys.flatMap(variantsOf);
        if (prefixes.some(p => allKeys.includes(p))) return section;
        if (allLabels.some(l => section.labels.includes(l))) return section;
    }

    return null;
}

function extractLinkedIssues(body) {
    const matches = [...body.matchAll(/(close[sd]?|fixe?[sd]?|resolve[sd]?)\s+#(\d+)/gi)];
    return matches.map(m => Number(m[2]));
}

async function main() {
    const { data: prs } = await octokit.pulls.list({
        owner,
        repo,
        state: "closed",
        per_page: 50,
        sort: "updated",
        direction: "desc",
    });

    let body = "# 🚀 Release Notes\n\n";
    const grouped = {};
    const allSections = SECTIONS.map(s => s.title);
    allSections.push("Other PRs");
    allSections.forEach(s => (grouped[s] = []));

    for (const pr of prs) {
        const linkedIssueNums = extractLinkedIssues(pr.body || "");
        let linkedIssues = [];
        for (const num of linkedIssueNums) {
            try {
                const { data: issue } = await octokit.issues.get({ owner, repo, issue_number: num });
                linkedIssues.push(issue);
            } catch {
                continue;
            }
        }

        const section = findSection(
            pr.title,
            pr.labels.map(l => l.name),
            linkedIssues[0]?.title,
            linkedIssues[0]?.labels?.map(l => l.name)
        );

        const issueText = linkedIssues.length
            ? linkedIssues
                .map(i => `${i.title} (#${i.number})`)
                .join(", ")
            : "";

        const line = `- ${pr.title} (#${pr.number})${issueText ? " closes " + issueText : ""} by @${pr.user.login}`;
        if (section) grouped[section.title].push(line);
        else grouped["Other PRs"].push(line);
    }

    for (const section of allSections) {
        const items = grouped[section];
        if (items.length) {
            body += `## ${section}\n${items.join("\n")}\n\n`;
        }
    }

    const { data: releases } = await octokit.repos.listReleases({ owner, repo });
    let draft = releases.find(r => r.draft);

    let nextVersion = "v0.1.0";
    const latest = releases.find(r => !r.draft) || releases[0];
    if (latest) {
        const match = latest.tag_name.match(/v(\d+)\.(\d+)\.(\d+)/);
        if (match) {
            const major = Number(match[1]);
            const minor = Number(match[2]);
            const patch = Number(match[3]) + 1;
            nextVersion = `v${major}.${minor}.${patch}`;
        }
    }

    const releaseName = nextVersion;
    const releaseTag = nextVersion;

    if (draft) {
        console.log("Updating existing draft release:", draft.tag_name);
        await octokit.repos.updateRelease({
            owner,
            repo,
            release_id: draft.id,
            name: releaseName,
            body,
        });
    } else {
        console.log("Creating new draft release");
        await octokit.repos.createRelease({
            owner,
            repo,
            tag_name: releaseTag,
            name: releaseName,
            body,
            draft: true,
        });
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
