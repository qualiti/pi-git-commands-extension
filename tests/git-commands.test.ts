import { describe, expect, it } from "vitest";
import { __test__ } from "../extensions/git-commands.ts";

describe("git-commands helpers", () => {
	it("parses porcelain status counts across staged, unstaged, untracked, and conflicts", () => {
		const result = __test__.parseStatus([
			"## main...origin/main [ahead 1]",
			"M  src/staged.ts",
			" M src/unstaged.ts",
			"MM src/both.ts",
			"?? src/new.ts",
			"UU src/conflicted.ts",
			"!! dist/output.js",
		].join("\n"));

		expect(result).toEqual({
			stagedCount: 2,
			unstagedCount: 2,
			untrackedCount: 1,
			conflictCount: 1,
			changedFileCount: 5,
		});
	});

	it("accepts fenced and loose JSON responses", () => {
		expect(__test__.parseLooseJson<{ subject: string }>("```json\n{\n  \"subject\": \"Add tests\"\n}\n```"))
			.toEqual({ subject: "Add tests" });
		expect(__test__.parseLooseJson<{ branch: string }>("here you go {\"branch\":\"feat/add-tests\"}"))
			.toEqual({ branch: "feat/add-tests" });
	});

	it("normalizes commit drafts and formats commit messages", () => {
		const draft = __test__.normalizeCommitDraft({
			subject: "Add repository tests.",
			body: "Cover git helper logic.\n",
		});

		expect(draft).toEqual({
			subject: "Add repository tests",
			body: "Cover git helper logic.",
		});
		expect(__test__.formatCommitMessage(draft)).toBe("Add repository tests\n\nCover git helper logic.");
	});

	it("builds predictable branch names from subjects and sanitizes invalid names", () => {
		expect(__test__.branchNameFromSubject("feat: Add Repository Tests")).toBe("pi/add-repository-tests");
		expect(__test__.sanitizeBranchName("refs/heads/Feat//Add Tests!!!")).toBe("feat/add-tests");
		expect(__test__.sanitizeBranchName("...///---")).toBe("pi/update-changes");
	});

	it("parses recent commit messages and summarizes style", () => {
		const commits = __test__.parseRecentCommitMessages([
			"feat: add tests\n\nCovers helpers",
			"fix: handle invalid JSON",
			"chore: update workflow",
		].join("\u0000"));

		expect(commits).toEqual([
			{ subject: "feat: add tests", body: "Covers helpers" },
			{ subject: "fix: handle invalid JSON", body: "" },
			{ subject: "chore: update workflow", body: "" },
		]);
		expect(__test__.buildCommitStyleSummary(commits)).toContain("Conventional Commit prefixes");
		expect(__test__.buildCommitStyleSummary(commits)).toContain("Bodies are uncommon");
		expect(__test__.formatRecentCommitExamples(commits)).toContain("1. feat: add tests\nCovers helpers");
	});

	it("extracts only text blocks from session content", () => {
		expect(
			__test__.extractTextBlocks([
				{ type: "text", text: "hello" },
				{ type: "tool_use", toolName: "bash" },
				{ type: "text", text: "world" },
			]),
		).toEqual(["hello", "world"]);
	});

	it("parses commit command args and preserves message hints", () => {
		expect(__test__.parseCommitCommandArgs("fix calendar overlap validation")).toEqual({
			messageHint: "fix calendar overlap validation",
			instructions: "",
		});
		expect(__test__.parseCommitCommandArgs('--instructions "Use Conventional Commits"')).toEqual({
			messageHint: "",
			instructions: "Use Conventional Commits",
		});
		expect(__test__.parseCommitCommandArgs("-I 'Always include ticket IDs'")).toEqual({
			messageHint: "",
			instructions: "Always include ticket IDs",
		});
		expect(__test__.parseCommitCommandArgs("--instructions=Keep subjects short")).toEqual({
			messageHint: "",
			instructions: "Keep subjects short",
		});
	});

	it("merges commit instruction sections with truncation", () => {
		expect(__test__.mergeCommitInstructionSections(["Use Conventional Commits", "", "Include ticket IDs"])).toBe(
			"Use Conventional Commits\n\nInclude ticket IDs",
		);
		expect(__test__.truncate(__test__.mergeCommitInstructionSections(["abcdef"]), 4)).toBe("abcd\n…[truncated]");
	});

	it("maps push failures to clearer user-facing messages", () => {
		expect(
			__test__.cleanPushError(
				{ stdout: "", stderr: "! [rejected] main -> main (non-fast-forward)", code: 1 },
				"origin/main",
			),
		).toBe("Push to origin/main was rejected. Pull or rebase first, then try again.");

		expect(
			__test__.cleanPushError(
				{ stdout: "", stderr: "fatal: could not read from remote repository", code: 1 },
				"origin/main",
			),
		).toBe("Push to origin/main failed because authentication was rejected.");
	});

	it("extracts PR URLs and preserves trailing newlines", () => {
		expect(__test__.extractPrUrl("Created https://github.com/acme/repo/pull/42 successfully")).toBe(
			"https://github.com/acme/repo/pull/42",
		);
		expect(__test__.ensureTrailingNewline("message")).toBe("message\n");
		expect(__test__.ensureTrailingNewline("message\n")).toBe("message\n");
		expect(__test__.truncate("abcdef", 4)).toBe("abcd\n…[truncated]");
	});
});
