import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import { execSync } from "child_process";

function detectRepo() {
    if (process.env.GITHUB_REPOSITORY) {
        const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
        return { owner, repo };
    }
    try {
        const remoteUrl = execSync("git config --get remote.origin.url").toString().trim();
        const match = remoteUrl.match(/[:/]([^/]+)\/([^/]+)(?:\.git)?$/);
        if (match) return { owner: match[1], repo: match[2] };
    } catch {}
    throw new Error("❌ Repository could not be detected.");
}

const DEV_BRANCH = "dev";
const MASTER_BRANCH = "master";
const { owner: OWNER, repo: REPO } = detectRepo();

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const graphqlWithAuth = graphql.defaults({
    headers: { authorization: `token ${process.env.GITHUB_TOKEN}` },
});

const PREFIX_MAP = {
    "task": "🚀 Tasks",
    "composite": "🚀 Tasks",
    "bug": "🐞 Bug Fixes",
    "fix": "🐞 Bug Fixes",
    "refactor": "🛠 Refactoring",
    "docs": "📚 Documentation",
    "test": "✅ Tests",
    "chore": "⚙️ Chores",
    "proposal": "💡 Ideas & Proposals",
    "idea": "💡 Ideas & Proposals",
    "discussion": "💡 Ideas & Proposals",
    "feat": "✨ New features & Enhancements",
    "enhancement": "✨ New features & Enhancements",
    "ux/ui": "✨ New features & Enhancements",
};

function stripLeadingEmoji(title) {
    let t = title.trim();
    t = t.replace(/^(:[a-zA-Z0-9_+-]+:)+\s*/g, ''); // :emoji:
    t = t.replace(/^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]+/u, ''); // Unicode emoji
    return t.trim();
}

function classifyTitle(title) {
    const t = stripLeadingEmoji(title);

    let match = t.match(/^\[([^\]]+)\]/);
    if (match) {
        const firstPrefix = match[1].split(',')[0].trim().toLowerCase();
        return PREFIX_MAP[firstPrefix] || "Other";
    }

    match = t.match(/^(bug|fix|feat|enhancement|refactor|docs|test|chore|task|composite|ux\/ui)[:\s-]+/i);
    if (match) {
        const prefix = match[1].toLowerCase();
        return PREFIX_MAP[prefix] || "Other";
    }

    return "Other";
}

function normalizeTitleForNotes(title) {
    let t = title.trim();

    t = t.replace(/^([\s\p{Emoji_Presentation}\p{Extended_Pictographic}]+|(:[a-zA-Z0-9_+-]+:)+)\s*/u, '');

    const bracketMatch = t.match(/^\[([^\]]+)\]/);
    if (bracketMatch) {
        const firstPrefix = bracketMatch[1].split(',')[0].trim();
        t = `[${firstPrefix}] ` + t.slice(bracketMatch[0].length).trimStart();
        return t;
    }

    const simpleMatch = t.match(/^(bug|fix|feat|enhancement|refactor|docs|test|chore|task|composite|ux\/ui)[:\s-]+/i);
    if (simpleMatch) {
        const prefix = simpleMatch[1].toLowerCase();
        t = t.replace(simpleMatch[0], `[${prefix.charAt(0).toUpperCase() + prefix.slice(1)}] `);
        return t;
    }

    return t;
}

async function getAllPRs({ owner, repo, base }) {
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

async function getLinkedIssues(prNumber) {
    const query = `
    query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          closingIssuesReferences(first: 10) {
            nodes {
              number
              title
            }
          }
        }
      }
    }`;
    try {
        const response = await graphqlWithAuth(query, { owner: OWNER, repo: REPO, number: prNumber });
        return response.repository.pullRequest.closingIssuesReferences.nodes.map(i => ({
            number: i.number,
            title: i.title,
        }));
    } catch {
        return [];
    }
}

function nextVersion(lastTag) {
    if (!lastTag) return "v0.1.0";
    const match = lastTag.match(/^v(\d+)\.(\d+)\.(\d+)/);
    if (!match) return "v0.1.0";
    let [, major, minor, patch] = match.map(Number);
    patch += 1;
    return `v${major}.${minor}.${patch}`;
}

async function main() {
    let lastRelease = null;
    try {
        const { data } = await octokit.repos.listReleases({ owner: OWNER, repo: REPO, per_page: 20 });
        const published = data.filter(r => !r.draft);
        lastRelease = published.length ? published[0] : null;
    } catch {}

    const since = lastRelease ? new Date(lastRelease.created_at) : null;
    const lastTag = lastRelease?.tag_name || null;
    const newTag = nextVersion(lastTag);

    const branches = await octokit.repos.listBranches({ owner: OWNER, repo: REPO });
    const branchNames = branches.data.map(b => b.name);
    let targetBranch = MASTER_BRANCH;
    if (branchNames.includes(DEV_BRANCH) && lastRelease) {
        try {
            const compare = await octokit.repos.compareCommits({
                owner: OWNER,
                repo: REPO,
                base: lastRelease.tag_name,
                head: DEV_BRANCH,
            });
            if (compare.data.commits.length > 0) targetBranch = DEV_BRANCH;
        } catch {}
    }

    const prs = await getAllPRs({ owner: OWNER, repo: REPO, base: targetBranch });
    const mergedPRs = prs.filter(pr => pr.merged_at && (!since || new Date(pr.merged_at) > since));

    const issueMap = {};
    const prsWithoutIssue = [];

    for (const pr of mergedPRs) {
        const linkedIssues = await getLinkedIssues(pr.number);
        if (linkedIssues.length) {
            for (const issue of linkedIssues) {
                if (!issueMap[issue.number]) issueMap[issue.number] = { title: issue.title, prs: [] };
                issueMap[issue.number].prs.push({ number: pr.number, user: pr.user?.login });
            }
        } else {
            prsWithoutIssue.push(pr);
        }
    }

    const sections = {
        "✨ New features & Enhancements": [],
        "🐞 Bug Fixes": [],
        "🚀 Tasks": [],
        "🛠 Refactoring": [],
        "📚 Documentation": [],
        "✅ Tests": [],
        "⚙️ Chores": [],
        "💡 Ideas & Proposals": [],
        Other: [],
    };

    for (const [num, info] of Object.entries(issueMap)) {
        const title = normalizeTitleForNotes(info.title);
        const section = classifyTitle(title);
        const prsText = info.prs
            .sort((a, b) => a.number - b.number)
            .map(p => `#${p.number} by @${p.user}`)
            .join(", ");
        sections[section].push(`#${num} ${title}\n↳ PRs: ${prsText}`);
    }

    for (const pr of prsWithoutIssue) {
        const title = normalizeTitleForNotes(pr.title);
        const section = classifyTitle(title);
        sections[section].push(`#${pr.number} ${title} by @${pr.user?.login}`);
    }

    let releaseNotesText = `## Draft Release Notes\n\n`;

    // New features & Enhancements — first
    const orderedSections = [
        "✨ New features & Enhancements",
        "🐞 Bug Fixes",
        "🚀 Tasks",
        "🛠 Refactoring",
        "📚 Documentation",
        "✅ Tests",
        "⚙️ Chores",
        "💡 Ideas & Proposals",
        "Other",
    ];

    for (const sectionName of orderedSections) {
        const items = sections[sectionName];
        if (!items.length) continue;
        items.sort((a, b) => parseInt(a.match(/#(\d+)/)[1]) - parseInt(b.match(/#(\d+)/)[1]));
        releaseNotesText += `### ${sectionName}\n`;
        items.forEach(i => releaseNotesText += `- ${i}\n`);
        releaseNotesText += `\n`;
    }

    console.log(releaseNotesText);

    let draftRelease = null;
    try {
        const { data: releases } = await octokit.repos.listReleases({ owner: OWNER, repo: REPO, per_page: 10 });
        draftRelease = releases.find(r => r.draft);
    } catch {}

    if (draftRelease) {
        await octokit.repos.updateRelease({
            owner: OWNER,
            repo: REPO,
            release_id: draftRelease.id,
            body: releaseNotesText,
            name: `Release ${draftRelease.tag_name}`,
        });
        console.log(`✅ Draft release updated: ${draftRelease.tag_name}`);
    } else {
        await octokit.repos.createRelease({
            owner: OWNER,
            repo: REPO,
            tag_name: newTag,
            name: `Release ${newTag}`,
            body: releaseNotesText,
            draft: true,
        });
        console.log(`✅ Draft release created: ${newTag}`);
    }

    console.log(`✅ Release processing completed`);
}

main().catch(err => {
    console.error("Error:", err);
    process.exit(1);
});
