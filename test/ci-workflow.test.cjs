const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("CI accepts pull requests targeting feature branches in the PR stack", () => {
	const workflow = fs.readFileSync(path.join(__dirname, "../.github/workflows/test.yml"), "utf8");
	const event = workflow.match(/^  pull_request:[^\n]*(?:\n(?: {4}[^\n]*|[ \t]*))*/m);
	assert.ok(event, "the test workflow must run on pull requests");
	assert.doesNotMatch(event[0], /branches(?:-ignore)?\s*:/, "PR tests must not filter out stacked feature-branch bases");
});
