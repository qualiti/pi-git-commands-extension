import { access, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionMessageEntry } from "@mariozechner/pi-coding-agent";

type NotifyLevel = "info" | "warning" | "error";
type CommitMode = "none" | "staged" | "all";

type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
};

type RepoState = {
	root: string;
	branch: string;
	upstream?: string;
	remotes: string[];
	stagedCount: number;
	unstagedCount: number;
	untrackedCount: number;
	conflictCount: number;
	changedFileCount: number;
	hasLocalChanges: boolean;
	aheadCount: number;
	behindCount: number;
	inProgress: string[];
};

type CommitResult = {
	sha: string;
	subject: string;
	body: string;
	mode: Exclude<CommitMode, "none">;
};

type PullRequestInfo = {
	url: string;
	number?: number;
	title?: string;
	state?: string;
	headRefName?: string;
	baseRefName?: string;
};

type ChangeSnapshot = {
	status: string;
	diffStat: string;
	diffPatch: string;
	untrackedFiles: string;
	recentCommitStyle: string;
	recentCommitExamples: string;
	headCommitSubject: string;
};

type CommitDraft = {
	subject: string;
	body: string;
};

const STATUS_KEY = "git-commands";
const MAX_SESSION_HISTORY_CHARS = 14_000;
const MAX_DIFF_CHARS = 18_000;
const MAX_DIFFSTAT_CHARS = 4_000;
const MAX_COMMITS_CHARS = 1_500;

const COMMIT_SYSTEM_PROMPT = `You write high-quality git commit messages.

Return strict JSON with this exact shape:
{
  "subject": "string",
  "body": "string"
}

Rules:
- Use the actual git changes as the primary source of truth.
- Use the session history to understand intent, motivation, and context.
- Match the repository's recent commit style when it fits the current change.
- The subject must be imperative, specific, and no longer than 72 characters.
- Do not end the subject with a period.
- The body is optional. Use an empty string when unnecessary.
- If you include a body, keep it concise and explain what changed and why.
- Do not mention Pi, AI, prompts, or that the message was generated.
- Output JSON only, with no markdown fences or commentary.`;

const BRANCH_SYSTEM_PROMPT = `You generate git branch names.

Return strict JSON with this exact shape:
{
  "branch": "string"
}

Rules:
- Base the name on the change intent and git changes.
- Prefer short, descriptive names in lowercase kebab-case.
- Slashes are allowed for grouping, for example feat/calendar-sync or fix/overlap-validation.
- Do not include spaces, quotes, markdown, refs/heads/, or punctuation other than / and -.
- Keep the branch name concise and practical.
- Output JSON only, with no markdown fences or commentary.`;

export default function gitCommandsExtension(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Commit current git changes with an auto-generated message",
		handler: async (args, ctx) => {
			await handleCommit(pi, args, ctx);
		},
	});

	pi.registerCommand("push", {
		description: "Push the current branch",
		handler: async (_args, ctx) => {
			await handlePush(pi, ctx);
		},
	});

	pi.registerCommand("commit-and-push", {
		description: "Commit current changes with an auto-generated message and push the current branch",
		handler: async (args, ctx) => {
			await handleCommitAndPush(pi, args, ctx);
		},
	});

	pi.registerCommand("commit-pr", {
		description: "Create a branch if needed, auto-commit, push, and create a PR if needed",
		handler: async (args, ctx) => {
			await handleCommitPr(pi, args, ctx);
		},
	});
}

async function handleCommit(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
	try {
		await ctx.waitForIdle();
		setStatus(ctx, "Inspecting git repository…");
		const repo = await inspectRepo(pi, ctx.cwd);
		ensureWritableRepo(repo);

		const mode = await chooseCommitMode(repo, ctx, false);
		if (mode === "none") {
			announce(ctx, "No changes to commit.", "info");
			return;
		}

		setStatus(ctx, "Generating commit message with Pi…");
		const draft = await resolveCommitDraft(pi, repo, ctx, mode, args);

		setStatus(ctx, mode === "all" ? "Staging and committing changes…" : "Committing staged changes…");
		const commit = await createCommit(pi, repo.root, formatCommitMessage(draft), mode);
		announce(ctx, `Committed ${commit.sha} on ${repo.branch}: ${commit.subject}`, "info");
	} catch (error) {
		announce(ctx, formatError(error), "error");
	} finally {
		clearStatus(ctx);
	}
}

async function handlePush(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	try {
		await ctx.waitForIdle();
		setStatus(ctx, "Inspecting git repository…");
		const repo = await inspectRepo(pi, ctx.cwd);
		ensurePushableRepo(repo);

		if (repo.upstream && repo.aheadCount === 0) {
			if (repo.behindCount > 0) {
				announce(ctx, `${repo.branch} is behind ${repo.upstream}. Pull or rebase before pushing.`, "warning");
				return;
			}

			if (repo.hasLocalChanges) {
				announce(
					ctx,
					`Nothing to push. ${repo.changedFileCount} uncommitted file(s) remain locally on ${repo.branch}.`,
					"warning",
				);
				return;
			}

			announce(ctx, `${repo.branch} is already up to date with ${repo.upstream}.`, "info");
			return;
		}

		if (repo.hasLocalChanges && ctx.hasUI) {
			const confirmed = await ctx.ui.confirm(
				"Push committed changes only?",
				`Your working tree has ${repo.changedFileCount} uncommitted file(s). /push only uploads commits that already exist on ${repo.branch}. Continue?`,
			);

			if (!confirmed) {
				announce(ctx, "Push cancelled.", "info");
				return;
			}
		}

		setStatus(ctx, "Pushing branch…");
		const pushedTo = await pushCurrentBranch(pi, repo, ctx);
		announce(ctx, `Pushed ${repo.branch} to ${pushedTo}.`, "info");
	} catch (error) {
		announce(ctx, formatError(error), "error");
	} finally {
		clearStatus(ctx);
	}
}

async function handleCommitAndPush(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
	try {
		await ctx.waitForIdle();
		setStatus(ctx, "Inspecting git repository…");
		const repo = await inspectRepo(pi, ctx.cwd);
		ensureWritableRepo(repo);

		let commitResult: CommitResult | undefined;

		if (repo.hasLocalChanges) {
			setStatus(ctx, "Generating commit message with Pi…");
			const draft = await resolveCommitDraft(pi, repo, ctx, "all", args);

			setStatus(ctx, "Staging and committing changes…");
			commitResult = await createCommit(pi, repo.root, formatCommitMessage(draft), "all");
		}

		const refreshed = await inspectRepo(pi, repo.root);
		ensurePushableRepo(refreshed);

		if (refreshed.upstream && refreshed.aheadCount === 0) {
			if (refreshed.behindCount > 0) {
				announce(ctx, `${refreshed.branch} is behind ${refreshed.upstream}. Pull or rebase before pushing.`, "warning");
				return;
			}

			if (commitResult) {
				announce(ctx, `Committed ${commitResult.sha}, but there is nothing new to push.`, "warning");
			} else {
				announce(ctx, "Nothing to commit or push.", "info");
			}
			return;
		}

		setStatus(ctx, "Pushing branch…");
		const pushedTo = await pushCurrentBranch(pi, refreshed, ctx);
		if (commitResult) {
			announce(ctx, `Committed ${commitResult.sha} and pushed ${refreshed.branch} to ${pushedTo}.`, "info");
		} else {
			announce(ctx, `Pushed ${refreshed.branch} to ${pushedTo}.`, "info");
		}
	} catch (error) {
		announce(ctx, formatError(error), "error");
	} finally {
		clearStatus(ctx);
	}
}

async function handleCommitPr(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
	try {
		await ctx.waitForIdle();
		setStatus(ctx, "Inspecting git repository…");
		let repo = await inspectRepo(pi, ctx.cwd);
		ensureWritableRepo(repo);

		if (repo.remotes.length === 0) {
			throw new Error("No git remote is configured for this repository.");
		}
		await ensureGhReady(pi, repo.root);

		const baseBranch = await resolveBaseBranch(pi, repo);
		if (repo.branch === baseBranch) {
			if (!repo.hasLocalChanges && repo.aheadCount === 0) {
				throw new Error(`No branchable work found on ${baseBranch}. Make a change or create a commit first.`);
			}

			setStatus(ctx, "Generating branch name with Pi…");
			const desiredBranch = await generateBranchName(pi, repo, ctx, "all", args, baseBranch);
			setStatus(ctx, `Creating branch ${desiredBranch}…`);
			const createdBranch = await createAndCheckoutBranch(pi, repo.root, desiredBranch);
			repo = await inspectRepo(pi, repo.root);
			announce(ctx, `Created branch ${createdBranch}.`, "info");
		}

		let commitResult: CommitResult | undefined;
		if (repo.hasLocalChanges) {
			setStatus(ctx, "Generating commit message with Pi…");
			const draft = await resolveCommitDraft(pi, repo, ctx, "all", args);

			setStatus(ctx, "Staging and committing changes…");
			commitResult = await createCommit(pi, repo.root, formatCommitMessage(draft), "all");
		}

		let refreshed = await inspectRepo(pi, repo.root);
		ensurePushableRepo(refreshed);

		if (!refreshed.upstream || refreshed.aheadCount > 0) {
			setStatus(ctx, "Pushing branch…");
			await pushCurrentBranch(pi, refreshed, ctx);
			refreshed = await inspectRepo(pi, repo.root);
		}

		setStatus(ctx, "Looking for an existing pull request…");
		const existingPr = await findCurrentBranchPr(pi, refreshed.root);
		if (existingPr) {
			announce(ctx, `PR already exists for ${refreshed.branch}: ${existingPr.url}`, "info");
			return;
		}

		const latestCommit = commitResult ?? (await getHeadCommit(pi, refreshed.root));
		setStatus(ctx, "Creating pull request…");
		const pr = await createPullRequest(pi, refreshed.root, refreshed.branch, baseBranch, latestCommit);
		announce(ctx, `Created PR for ${refreshed.branch}: ${pr.url}`, "info");
	} catch (error) {
		announce(ctx, formatError(error), "error");
	} finally {
		clearStatus(ctx);
	}
}

async function inspectRepo(pi: ExtensionAPI, cwd: string): Promise<RepoState> {
	const inside = await run(pi, cwd, "git", ["rev-parse", "--is-inside-work-tree"]);
	if (inside.code !== 0 || inside.stdout.trim() !== "true") {
		throw new Error("This command only works inside a git repository.");
	}

	const rootResult = await run(pi, cwd, "git", ["rev-parse", "--show-toplevel"]);
	if (rootResult.code !== 0) {
		throw new Error(cleanErrorText(rootResult) || "Could not determine the repository root.");
	}
	const root = rootResult.stdout.trim();

	const branchResult = await run(pi, root, "git", ["branch", "--show-current"]);
	if (branchResult.code !== 0) {
		throw new Error(cleanErrorText(branchResult) || "Could not determine the current branch.");
	}
	const branch = branchResult.stdout.trim();
	if (!branch) {
		throw new Error("You are on a detached HEAD. Check out a branch first.");
	}

	const statusResult = await run(pi, root, "git", ["status", "--porcelain=v1", "--branch"]);
	if (statusResult.code !== 0) {
		throw new Error(cleanErrorText(statusResult) || "Could not inspect git status.");
	}

	const upstreamResult = await run(pi, root, "git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
	const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() || undefined : undefined;

	const remotesResult = await run(pi, root, "git", ["remote"]);
	const remotes = remotesResult.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	let aheadCount = 0;
	let behindCount = 0;
	if (upstream) {
		const counts = await run(pi, root, "git", ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
		if (counts.code === 0) {
			const [behindText, aheadText] = counts.stdout.trim().split(/\s+/);
			behindCount = Number.parseInt(behindText ?? "0", 10) || 0;
			aheadCount = Number.parseInt(aheadText ?? "0", 10) || 0;
		}
	}

	const inProgress = await detectInProgressOperations(pi, root);
	const parsedStatus = parseStatus(statusResult.stdout);

	return {
		root,
		branch,
		upstream,
		remotes,
		stagedCount: parsedStatus.stagedCount,
		unstagedCount: parsedStatus.unstagedCount,
		untrackedCount: parsedStatus.untrackedCount,
		conflictCount: parsedStatus.conflictCount,
		changedFileCount: parsedStatus.changedFileCount,
		hasLocalChanges: parsedStatus.changedFileCount > 0,
		aheadCount,
		behindCount,
		inProgress,
	};
}

function parseStatus(statusText: string) {
	let stagedCount = 0;
	let unstagedCount = 0;
	let untrackedCount = 0;
	let conflictCount = 0;
	let changedFileCount = 0;

	for (const line of statusText.split(/\r?\n/)) {
		if (!line || line.startsWith("## ") || line.startsWith("!! ")) continue;
		changedFileCount += 1;

		if (line.startsWith("?? ")) {
			untrackedCount += 1;
			continue;
		}

		const x = line[0] ?? " ";
		const y = line[1] ?? " ";
		if (isUnmergedStatus(x, y)) {
			conflictCount += 1;
			continue;
		}

		if (x !== " ") stagedCount += 1;
		if (y !== " ") unstagedCount += 1;
	}

	return { stagedCount, unstagedCount, untrackedCount, conflictCount, changedFileCount };
}

function isUnmergedStatus(x: string, y: string) {
	const pair = `${x}${y}`;
	return new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]).has(pair);
}

async function detectInProgressOperations(pi: ExtensionAPI, cwd: string) {
	const operations: string[] = [];
	const candidates: Array<[string, string]> = [
		["MERGE_HEAD", "merge"],
		["CHERRY_PICK_HEAD", "cherry-pick"],
		["REVERT_HEAD", "revert"],
		["rebase-merge", "rebase"],
		["rebase-apply", "rebase"],
	];

	for (const [gitPathName, label] of candidates) {
		const gitPath = await run(pi, cwd, "git", ["rev-parse", "--git-path", gitPathName]);
		if (gitPath.code !== 0) continue;
		if (await pathExists(gitPath.stdout.trim())) {
			if (!operations.includes(label)) operations.push(label);
		}
	}

	return operations;
}

async function chooseCommitMode(repo: RepoState, ctx: ExtensionCommandContext, preferAll: boolean): Promise<CommitMode> {
	if (!repo.hasLocalChanges) return "none";
	if (preferAll) return "all";

	const hasStaged = repo.stagedCount > 0;
	const hasUnstaged = repo.unstagedCount > 0 || repo.untrackedCount > 0;

	if (hasStaged && hasUnstaged) {
		if (!ctx.hasUI) {
			throw new Error(
				"You have both staged and unstaged changes. Re-run /commit interactively or stage the exact changes you want first.",
			);
		}

		const choice = await ctx.ui.select("Commit which changes?", [
			"Commit staged changes only",
			"Stage all changes and commit everything",
			"Cancel",
		]);

		if (choice === "Commit staged changes only") return "staged";
		if (choice === "Stage all changes and commit everything") return "all";
		return "none";
	}

	if (hasStaged) return "staged";
	return "all";
}

async function resolveCommitDraft(
	pi: ExtensionAPI,
	repo: RepoState,
	ctx: ExtensionCommandContext,
	mode: Exclude<CommitMode, "none">,
	args: string,
): Promise<CommitDraft> {
	const provided = args.trim();
	if (provided) {
		return normalizeCommitDraft(splitCommitMessage(provided));
	}

	const snapshot = await buildChangeSnapshot(pi, repo.root, mode);
	const sessionHistory = buildSessionHistory(pi, ctx);
	const sessionName = typeof pi.getSessionName === "function" ? pi.getSessionName() ?? "" : "";

	const prompt = [
		`Current branch: ${repo.branch}`,
		`Commit mode: ${mode}`,
		sessionName ? `Session name: ${sessionName}` : "",
		"",
		"Git status:",
		snapshot.status || "(empty)",
		"",
		"Diff stat:",
		snapshot.diffStat || "(empty)",
		"",
		"Untracked files:",
		snapshot.untrackedFiles || "(none)",
		"",
		"Recent commit style:",
		snapshot.recentCommitStyle || "(none)",
		"",
		"Recent commit examples:",
		snapshot.recentCommitExamples || "(none)",
		"",
		"Session history:",
		sessionHistory || "(none)",
		"",
		"Selected diff patch:",
		snapshot.diffPatch || "(empty)",
	].join("\n");

	const responseText = await generateWithPi(ctx, COMMIT_SYSTEM_PROMPT, prompt);
	const parsed = parseLooseJson<{ subject?: string; body?: string }>(responseText);
	return normalizeCommitDraft({
		subject: parsed.subject,
		body: parsed.body,
	});
}

async function generateBranchName(
	pi: ExtensionAPI,
	repo: RepoState,
	ctx: ExtensionCommandContext,
	mode: Exclude<CommitMode, "none">,
	args: string,
	baseBranch: string,
): Promise<string> {
	const snapshot = await buildChangeSnapshot(pi, repo.root, mode);
	const sessionHistory = buildSessionHistory(pi, ctx);
	const sessionName = typeof pi.getSessionName === "function" ? pi.getSessionName() ?? "" : "";
	const provided = args.trim();

	const prompt = [
		`Current branch: ${repo.branch}`,
		`Base branch: ${baseBranch}`,
		sessionName ? `Session name: ${sessionName}` : "",
		provided ? `User-provided commit hint: ${provided}` : "",
		snapshot.headCommitSubject ? `Latest local commit subject: ${snapshot.headCommitSubject}` : "",
		"",
		"Git status:",
		snapshot.status || "(empty)",
		"",
		"Diff stat:",
		snapshot.diffStat || "(empty)",
		"",
		"Untracked files:",
		snapshot.untrackedFiles || "(none)",
		"",
		"Session history:",
		sessionHistory || "(none)",
		"",
		"Selected diff patch:",
		snapshot.diffPatch || "(empty)",
	].join("\n");

	const responseText = await generateWithPi(ctx, BRANCH_SYSTEM_PROMPT, prompt);
	const parsed = parseLooseJson<{ branch?: string }>(responseText);
	const fallbackBase = provided || snapshot.headCommitSubject || "update-changes";
	return sanitizeBranchName(parsed.branch || branchNameFromSubject(fallbackBase));
}

async function buildChangeSnapshot(
	pi: ExtensionAPI,
	repoRoot: string,
	mode: Exclude<CommitMode, "none">,
): Promise<ChangeSnapshot> {
	const status = await run(pi, repoRoot, "git", ["status", "--short"]);
	const untracked = await run(pi, repoRoot, "git", ["ls-files", "--others", "--exclude-standard"]);
	const recentMessages = await run(pi, repoRoot, "git", ["log", "-n", "8", "--pretty=format:%s%n%b%x00"]);
	const headSubject = await run(pi, repoRoot, "git", ["log", "-1", "--pretty=%s"]);
	const hasHead = await run(pi, repoRoot, "git", ["rev-parse", "--verify", "HEAD"]);

	const diffPrefix = mode === "staged" ? ["diff", "--cached"] : hasHead.code === 0 ? ["diff", "HEAD"] : undefined;
	let diffStat = "";
	let diffPatch = "";

	if (diffPrefix) {
		const diffStatResult = await run(pi, repoRoot, "git", [
			...diffPrefix,
			"--stat",
			"--summary",
			"--find-renames",
			"--no-ext-diff",
		]);
		if (diffStatResult.code === 0) {
			diffStat = truncate(diffStatResult.stdout.trim(), MAX_DIFFSTAT_CHARS);
		}

		const diffPatchResult = await run(pi, repoRoot, "git", [
			...diffPrefix,
			"--find-renames",
			"--no-ext-diff",
			"--submodule=short",
			"--unified=2",
		]);
		if (diffPatchResult.code === 0) {
			diffPatch = truncate(diffPatchResult.stdout.trim(), MAX_DIFF_CHARS);
		}
	}

	const recentCommitList = recentMessages.code === 0 ? parseRecentCommitMessages(recentMessages.stdout) : [];
	const recentCommitStyle = buildCommitStyleSummary(recentCommitList);
	const recentCommitExamples = formatRecentCommitExamples(recentCommitList);

	return {
		status: truncate(status.stdout.trim(), 3_000),
		diffStat,
		diffPatch,
		untrackedFiles: truncate(untracked.stdout.trim(), 2_000),
		recentCommitStyle: truncate(recentCommitStyle, 1_000),
		recentCommitExamples: truncate(recentCommitExamples, MAX_COMMITS_CHARS),
		headCommitSubject: headSubject.code === 0 ? headSubject.stdout.trim() : "",
	};
}

function parseRecentCommitMessages(text: string): CommitDraft[] {
	return text
		.split("\u0000")
		.map((chunk) => chunk.trim())
		.filter(Boolean)
		.map(splitCommitMessage)
		.filter((commit) => commit.subject);
}

function buildCommitStyleSummary(commits: CommitDraft[]) {
	if (commits.length === 0) return "";

	const conventionalCount = commits.filter((commit) => /^[a-z]+(?:\([^)]+\))?!?:\s/.test(commit.subject)).length;
	const capitalizedCount = commits.filter((commit) => /^[A-Z]/.test(commit.subject)).length;
	const bodyCount = commits.filter((commit) => commit.body.trim().length > 0).length;
	const trailingPeriodCount = commits.filter((commit) => commit.subject.endsWith(".")).length;

	const notes: string[] = [];
	if (conventionalCount >= Math.ceil(commits.length / 2)) {
		notes.push("Subjects usually use Conventional Commit prefixes.");
	} else if (capitalizedCount >= Math.ceil(commits.length / 2)) {
		notes.push("Subjects usually start with a capitalized imperative phrase.");
	} else {
		notes.push("Subjects usually stay short and informal without strict prefixes.");
	}

	if (bodyCount === 0) {
		notes.push("Bodies are usually omitted.");
	} else if (bodyCount <= Math.floor(commits.length / 3)) {
		notes.push("Bodies are uncommon; include one only when extra context matters.");
	} else {
		notes.push("Bodies are commonly used for extra context.");
	}

	if (trailingPeriodCount === 0) {
		notes.push("Subjects typically do not end with periods.");
	}

	return notes.join(" ");
}

function formatRecentCommitExamples(commits: CommitDraft[]) {
	if (commits.length === 0) return "";
	return commits
		.slice(0, 6)
		.map((commit, index) => {
			const body = commit.body ? `\n${truncate(commit.body, 180)}` : "";
			return `${index + 1}. ${commit.subject}${body}`;
		})
		.join("\n\n");
}

function buildSessionHistory(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	const branch = ctx.sessionManager.getBranch();
	const relevant = branch.filter((entry): entry is SessionMessageEntry => entry.type === "message");
	const tail = relevant.slice(-24);
	const sections: string[] = [];
	const sessionName = typeof pi.getSessionName === "function" ? pi.getSessionName() : undefined;

	if (sessionName) {
		sections.push(`Session: ${sessionName}`);
	}

	for (const entry of tail) {
		const message = entry.message as { role?: string; content?: unknown } | undefined;
		if (!message?.role) continue;
		if (!["user", "assistant", "toolResult"].includes(message.role)) continue;

		const text = extractTextBlocks(message.content).join("\n").trim();
		if (!text) continue;
		const roleLabel = message.role === "toolResult" ? "Tool" : message.role === "assistant" ? "Assistant" : "User";
		sections.push(`${roleLabel}: ${text}`);
	}

	return truncate(sections.join("\n\n"), MAX_SESSION_HISTORY_CHARS);
}

function extractTextBlocks(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const block = item as { type?: string; text?: string; toolName?: string };
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts;
}

async function generateWithPi(ctx: ExtensionCommandContext, systemPrompt: string, prompt: string) {
	const model = await resolveGenerationModel(ctx);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key available for ${model.provider}/${model.id}.` : auth.error);
	}

	const response = await complete(
		model,
		{
			systemPrompt,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			reasoningEffort: "minimal",
		},
	);

	const text = response.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();

	if (!text) {
		throw new Error("Pi returned an empty result while generating git metadata.");
	}

	return text;
}

async function resolveGenerationModel(ctx: ExtensionCommandContext) {
	if (ctx.model) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (auth.ok && auth.apiKey) {
			return ctx.model;
		}
	}

	const available = await ctx.modelRegistry.getAvailable();
	if (available.length > 0) {
		return available[0]!;
	}

	throw new Error("No authenticated model is available to generate git metadata. Select a model or log in first.");
}

function parseLooseJson<T extends Record<string, unknown>>(text: string): T {
	const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start >= 0 && end > start) {
			return JSON.parse(trimmed.slice(start, end + 1)) as T;
		}
		throw new Error("Pi returned invalid JSON while generating git metadata.");
	}
}

function splitCommitMessage(message: string): CommitDraft {
	const normalized = message.trim();
	const [subjectLine, ...rest] = normalized.split(/\r?\n/);
	return {
		subject: subjectLine?.trim() || "Update files",
		body: rest.join("\n").trim(),
	};
}

function normalizeCommitDraft(draft: { subject?: string; body?: string }): CommitDraft {
	const subject = (draft.subject ?? "").trim();
	if (!subject) {
		throw new Error("Pi could not generate a valid commit subject.");
	}

	return {
		subject: subject.replace(/\.$/, "").slice(0, 72).trim(),
		body: (draft.body ?? "").trim(),
	};
}

function formatCommitMessage(draft: CommitDraft) {
	return draft.body ? `${draft.subject}\n\n${draft.body}` : draft.subject;
}

function branchNameFromSubject(subject: string) {
	const normalized = subject
		.toLowerCase()
		.replace(/^[a-z]+:\s*/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return `pi/${normalized || "update-changes"}`;
}

function sanitizeBranchName(input: string) {
	const cleaned = input
		.trim()
		.toLowerCase()
		.replace(/^refs\/heads\//, "")
		.replace(/[^a-z0-9/_-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/\/{2,}/g, "/")
		.replace(/^[-/.]+|[-/.]+$/g, "")
		.split("/")
		.filter(Boolean)
		.join("/")
		.slice(0, 90);
	return cleaned || "pi/update-changes";
}

async function createAndCheckoutBranch(pi: ExtensionAPI, repoRoot: string, desiredBranch: string) {
	let candidate = sanitizeBranchName(desiredBranch);
	candidate = await ensureUniqueBranchName(pi, repoRoot, candidate);

	const formatResult = await run(pi, repoRoot, "git", ["check-ref-format", "--branch", candidate]);
	if (formatResult.code !== 0) {
		candidate = await ensureUniqueBranchName(pi, repoRoot, branchNameFromSubject(candidate));
	}

	const createResult = await run(pi, repoRoot, "git", ["checkout", "-b", candidate], 30_000);
	if (createResult.code !== 0) {
		throw new Error(cleanErrorText(createResult) || `Could not create branch ${candidate}.`);
	}

	return candidate;
}

async function ensureUniqueBranchName(pi: ExtensionAPI, repoRoot: string, baseBranch: string) {
	for (let index = 0; index < 50; index++) {
		const candidate = index === 0 ? baseBranch : `${baseBranch}-${index + 1}`;
		const exists = await run(pi, repoRoot, "git", ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
		if (exists.code !== 0) {
			return candidate;
		}
	}
	throw new Error(`Could not find a unique branch name starting from ${baseBranch}.`);
}

async function createCommit(pi: ExtensionAPI, repoRoot: string, message: string, mode: Exclude<CommitMode, "none">): Promise<CommitResult> {
	if (mode === "all") {
		const addResult = await run(pi, repoRoot, "git", ["add", "-A"]);
		if (addResult.code !== 0) {
			throw new Error(cleanErrorText(addResult) || "git add failed.");
		}
	}

	const tempFile = path.join(os.tmpdir(), `pi-git-message-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
	await writeFile(tempFile, ensureTrailingNewline(message), "utf8");

	try {
		const commitResult = await run(pi, repoRoot, "git", ["commit", "-F", tempFile], 120_000);
		if (commitResult.code !== 0) {
			throw new Error(cleanErrorText(commitResult) || "git commit failed.");
		}
	} finally {
		await rm(tempFile, { force: true });
	}

	return getHeadCommit(pi, repoRoot, mode);
}

async function getHeadCommit(
	pi: ExtensionAPI,
	repoRoot: string,
	mode: Exclude<CommitMode, "none"> = "all",
): Promise<CommitResult> {
	const shaResult = await run(pi, repoRoot, "git", ["rev-parse", "--short", "HEAD"]);
	if (shaResult.code !== 0) {
		throw new Error(cleanErrorText(shaResult) || "Could not resolve the new commit SHA.");
	}

	const subjectResult = await run(pi, repoRoot, "git", ["log", "-1", "--pretty=%s"]);
	const bodyResult = await run(pi, repoRoot, "git", ["log", "-1", "--pretty=%b"]);
	if (subjectResult.code !== 0 || bodyResult.code !== 0) {
		throw new Error("Could not read the latest commit message.");
	}

	return {
		sha: shaResult.stdout.trim(),
		subject: subjectResult.stdout.trim(),
		body: bodyResult.stdout.trim(),
		mode,
	};
}

async function pushCurrentBranch(pi: ExtensionAPI, repo: RepoState, ctx: ExtensionCommandContext) {
	if (repo.upstream) {
		if (repo.behindCount > 0 && repo.aheadCount > 0) {
			throw new Error(`Branch ${repo.branch} has diverged from ${repo.upstream}. Pull or rebase before pushing.`);
		}
		if (repo.behindCount > 0) {
			throw new Error(`Branch ${repo.branch} is behind ${repo.upstream}. Pull or rebase before pushing.`);
		}

		const result = await run(pi, repo.root, "git", ["push", "--porcelain"], 120_000);
		if (result.code !== 0) {
			throw new Error(cleanPushError(result, repo.upstream));
		}
		return repo.upstream;
	}

	const remote = await resolvePushRemote(repo, ctx);
	const result = await run(
		pi,
		repo.root,
		"git",
		["push", "--porcelain", "-u", remote, `HEAD:refs/heads/${repo.branch}`],
		120_000,
	);
	if (result.code !== 0) {
		throw new Error(cleanPushError(result, `${remote}/${repo.branch}`));
	}
	return `${remote}/${repo.branch}`;
}

async function resolvePushRemote(repo: RepoState, ctx: ExtensionCommandContext) {
	if (repo.upstream) {
		return repo.upstream.split("/")[0] ?? repo.upstream;
	}
	if (repo.remotes.includes("origin")) return "origin";
	if (repo.remotes.length === 1) return repo.remotes[0]!;
	if (repo.remotes.length === 0) {
		throw new Error("No git remote is configured for this repository.");
	}
	if (!ctx.hasUI) {
		throw new Error("This branch has no upstream and multiple remotes exist. Re-run interactively to choose a remote.");
	}

	const choice = await ctx.ui.select("Choose a remote for the first push", repo.remotes);
	if (!choice) {
		throw new Error("Push cancelled.");
	}
	return choice;
}

async function ensureGhReady(pi: ExtensionAPI, cwd: string) {
	const version = await run(pi, cwd, "gh", ["--version"]);
	if (version.code !== 0) {
		throw new Error("GitHub CLI (gh) is not installed or not available on PATH.");
	}

	const auth = await run(pi, cwd, "gh", ["auth", "status"], 30_000);
	if (auth.code !== 0) {
		throw new Error("gh is not authenticated. Run `gh auth login` and try again.");
	}
}

async function resolveBaseBranch(pi: ExtensionAPI, repo: RepoState) {
	const configKey = `branch.${repo.branch}.gh-merge-base`;
	const configured = await run(pi, repo.root, "git", ["config", "--get", configKey]);
	if (configured.code === 0 && configured.stdout.trim()) {
		return configured.stdout.trim();
	}

	const defaultBranch = await run(
		pi,
		repo.root,
		"gh",
		["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
		30_000,
	);
	if (defaultBranch.code !== 0 || !defaultBranch.stdout.trim()) {
		throw new Error(cleanErrorText(defaultBranch) || "Could not determine the repository default branch.");
	}
	return defaultBranch.stdout.trim();
}

async function findCurrentBranchPr(pi: ExtensionAPI, cwd: string): Promise<PullRequestInfo | undefined> {
	const result = await run(
		pi,
		cwd,
		"gh",
		["pr", "view", "--json", "url,number,title,state,headRefName,baseRefName"],
		30_000,
	);
	if (result.code === 0) {
		return JSON.parse(result.stdout) as PullRequestInfo;
	}

	const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
	if (combined.includes("no pull requests found") || combined.includes("no pull request found")) {
		return undefined;
	}

	throw new Error(cleanErrorText(result) || "Could not determine whether a PR already exists for this branch.");
}

async function createPullRequest(
	pi: ExtensionAPI,
	cwd: string,
	branch: string,
	baseBranch: string,
	commit: CommitResult,
): Promise<PullRequestInfo> {
	const body = commit.body.trim();
	const result = await run(
		pi,
		cwd,
		"gh",
		[
			"pr",
			"create",
			"--base",
			baseBranch,
			"--head",
			branch,
			"--title",
			commit.subject,
			"--body",
			body || commit.subject,
		],
		120_000,
	);

	if (result.code !== 0) {
		const duplicateUrl = extractPrUrl(`${result.stdout}\n${result.stderr}`);
		if (duplicateUrl) {
			return { url: duplicateUrl };
		}
		throw new Error(cleanErrorText(result) || "Failed to create the pull request.");
	}

	const url = extractPrUrl(result.stdout) ?? extractPrUrl(result.stderr);
	if (!url) {
		throw new Error("The PR was created, but its URL could not be determined.");
	}

	return { url };
}

function ensureWritableRepo(repo: RepoState) {
	if (repo.conflictCount > 0) {
		throw new Error("Cannot continue while git has unresolved conflicts.");
	}
	if (repo.inProgress.length > 0) {
		throw new Error(`Cannot continue while a ${repo.inProgress.join(", ")} is in progress.`);
	}
}

function ensurePushableRepo(repo: RepoState) {
	if (repo.conflictCount > 0) {
		throw new Error("Cannot continue while git has unresolved conflicts.");
	}
	if (repo.inProgress.length > 0) {
		throw new Error(`Cannot continue while a ${repo.inProgress.join(", ")} is in progress.`);
	}
}

async function run(
	pi: ExtensionAPI,
	cwd: string,
	command: string,
	args: string[],
	timeout = 20_000,
): Promise<ExecResult> {
	const result = await pi.exec(command, args, { cwd, timeout });
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.code,
		killed: result.killed,
	};
}

async function pathExists(filePath: string) {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

function extractPrUrl(text: string) {
	return text.match(/https?:\/\/\S+\/pull\/\d+/)?.[0];
}

function cleanPushError(result: ExecResult, target: string) {
	const text = cleanErrorText(result);
	const lower = text?.toLowerCase() ?? "";
	if (lower.includes("failed to push some refs") || lower.includes("non-fast-forward")) {
		return `Push to ${target} was rejected. Pull or rebase first, then try again.`;
	}
	if (
		lower.includes("could not read from remote repository") ||
		lower.includes("permission denied") ||
		lower.includes("authentication failed")
	) {
		return `Push to ${target} failed because authentication was rejected.`;
	}
	if (lower.includes("could not resolve host") || lower.includes("unable to access")) {
		return `Push to ${target} failed because the remote could not be reached.`;
	}
	return text || `Push to ${target} failed.`;
}

function cleanErrorText(result: ExecResult) {
	const text = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
	return text || undefined;
}

function ensureTrailingNewline(text: string) {
	return text.endsWith("\n") ? text : `${text}\n`;
}

function truncate(text: string, maxChars: number) {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n…[truncated]`;
}

function setStatus(ctx: ExtensionCommandContext, text: string) {
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
}

function clearStatus(ctx: ExtensionCommandContext) {
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "");
}

function announce(ctx: ExtensionCommandContext, message: string, level: NotifyLevel) {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	} else {
		console.log(message);
	}
}

function formatError(error: unknown) {
	if (error instanceof Error) return error.message;
	return String(error);
}
