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
    "[Feat]": "✨ New Features",
    "[Enhancement]": "🔧 Enhancements",
    "[Bug]": "🐞 Bug Fixes",
    "[Refactor]": "♻️ Refactoring",
    "[Docs]": "📚 Documentation",
    "[Test]": "🧪 Tests",
    "[Chore]": "🧹 Chores",
};

function stripPrefix(title) {
    return title.replace(/^\[[^\]]+\]\s*/, "");
}

function detectPrefix(title) {
    const match = title.match(/^\[([^\]]+)\]/);
    return match ? `[${match[1]}]` : null;
}

async function main() {
    const { data: prs } = await octokit.pulls.list({
        owner,
        repo,
        state: "closed",
        per_page: 100,
        sort: "updated",
        direction: "desc",
    });

    const { data: issues } = await octokit.issues.listForRepo({
        owner,
        repo,
        state: "closed",
        per_page: 100,
    });

    const issueMap = new Map();
    for (const issue of issues) {
        issueMap.set(issue.number, { ...issue, prs: [] });
    }

    for (const pr of prs) {
        if (!pr.merged_at) continue;

        const linkedIssues = (pr.body?.match(/#(\d+)/g) || [])
            .map((s) => parseInt(s.replace("#", ""), 10))
            .filter((n) => issueMap.has(n));

        if (linkedIssues.length) {
            for (const id of linkedIssues) {
                issueMap.get(id).prs.push(pr);
            }
        } else {
            issueMap.set(`pr-${pr.number}`, { title: pr.title, prs: [pr], isStandalone: true });
        }
    }

    let body = "# 🚀 Release Notes\n\n";

    const groupedBySection = {};

    for (const issue of issueMap.values()) {
        const title = issue.title || "";
        const prefix = detectPrefix(title) || detectPrefix(issue.prs?.[0]?.title || "") || "[Other]";
        const sectionTitle = SECTIONS[prefix] || "🗂️ Other";

        groupedBySection[sectionTitle] ||= [];

        if (issue.isStandalone) {
            const pr = issue.prs[0];
            groupedBySection[sectionTitle].push(
                `- ${prefix} ${stripPrefix(pr.title)} (#${pr.number}) by @${pr.user.login}`
            );
        } else {
            const issueNumber = issue.number;
            const issueLine = `- ${prefix} ${stripPrefix(title)} (#${issueNumber})`;
            const prRefs = issue.prs.map((pr) => `#${pr.number}`).join(", ");
            groupedBySection[sectionTitle].push(`${issueLine}\n  ↳ PRs: ${prRefs}`);
        }
    }

    for (const [section, items] of Object.entries(groupedBySection)) {
        body += `## ${section}\n${items.join("\n")}\n\n`;
    }

    const { data: releases } = await octokit.repos.listReleases({ owner, repo });
    let draft = releases.find((r) => r.draft);

    let nextVersion = "v0.1.0";
    const latest = releases.find((r) => !r.draft) || releases[0];
    if (latest) {
        const match = latest.tag_name?.match(/v(\d+)\.(\d+)\.(\d+)/);
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

    console.log("✅ Draft release updated successfully");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
