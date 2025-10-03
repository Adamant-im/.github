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
    "[Bug]": "🐞 Bug Fixes",
    "[Feat]": "✨ New Features",
    "[Enhancement]": "🔧 Enhancements",
    "[Refactor]": "♻️ Refactoring",
    "[Docs]": "📚 Documentation",
    "[Test]": "🧪 Tests",
    "[Chore]": "🧹 Chores",
};

function stripPrefix(title) {
    return title.replace(/^\[[^\]]+\]\s*/, "");
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
    const groupedPRs = new Set();

    for (const [prefix, sectionTitle] of Object.entries(SECTIONS)) {
        const items = prs
            .filter(pr => pr.title.startsWith(prefix))
            .map(pr => {
                groupedPRs.add(pr.number);
                return `- ${stripPrefix(pr.title)} (#${pr.number}) by @${pr.user.login}`;
            });
        if (items.length) {
            body += `## ${sectionTitle}\n${items.join("\n")}\n\n`;
        }
    }

    const otherPRs = prs
        .filter(pr => !groupedPRs.has(pr.number))
        .map(pr => `- ${pr.title} (#${pr.number}) by @${pr.user.login}`);

    if (otherPRs.length) {
        body += `## Other PRs\n${otherPRs.join("\n")}\n\n`;
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
