const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

test("package bundles croner for Pi preserved-symlink extension loading", () => {
	const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
	assert.equal(pkg.dependencies?.croner, "10.0.1");
	assert.ok(
		pkg.bundleDependencies?.includes("croner") || pkg.bundledDependencies?.includes("croner"),
		"croner must be bundled so Pi package discovery can resolve it under pnpm symlinks",
	);
});
