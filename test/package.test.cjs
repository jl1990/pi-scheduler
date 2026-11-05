const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("repository uses pnpm as its single package manager", () => {
	const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
	assert.match(pkg.packageManager ?? "", /^pnpm@\d+\.\d+\.\d+$/);
	assert.equal(existsSync(resolve(root, "package-lock.json")), false, "keep only pnpm-lock.yaml");
});

test("package bundles croner for Pi preserved-symlink extension loading", () => {
	const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
	const lock = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
	for (const dependency of ["croner", "proper-lockfile"]) {
		const version = pkg.dependencies?.[dependency];
		assert.match(version ?? "", /^\d+\.\d+\.\d+$/, `${dependency} must be pinned to an exact version`);
		const entry = new RegExp(`\\n {6}${escapeRegExp(dependency)}:\\n {8}specifier: ${escapeRegExp(version)}\\n {8}version: ${escapeRegExp(version)}\\n`);
		assert.match(lock, entry, `${dependency} lockfile entry must match package.json`);
		assert.ok(
			pkg.bundleDependencies?.includes(dependency) || pkg.bundledDependencies?.includes(dependency),
			`${dependency} must be bundled so Pi package discovery can resolve it under pnpm symlinks`,
		);
	}
});
