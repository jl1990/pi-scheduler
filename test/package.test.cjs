const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

test("package bundles croner for Pi preserved-symlink extension loading", () => {
	const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
	assert.equal(pkg.dependencies?.croner, "10.0.1");
	assert.equal(pkg.dependencies?.["proper-lockfile"], "4.1.2");
	for (const dependency of ["croner", "proper-lockfile"]) {
		assert.ok(
			pkg.bundleDependencies?.includes(dependency) || pkg.bundledDependencies?.includes(dependency),
			`${dependency} must be bundled so Pi package discovery can resolve it under pnpm symlinks`,
		);
	}
});
