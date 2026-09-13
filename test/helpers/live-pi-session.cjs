const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");

function installedPiPackage() {
	const bin = process.env.PI_SCHEDULER_PI_BIN || execFileSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" }).trim();
	const shim = fs.readFileSync(bin, "utf8");
	let current = fs.existsSync(bin) && shim.includes("cmd-shim-target=")
		? shim.match(/cmd-shim-target=(.*)/)?.[1].trim()
		: fs.realpathSync(bin);
	while (current !== path.dirname(current)) {
		if (fs.existsSync(path.join(current, "package.json"))) {
			const pkg = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8"));
			if (pkg.name === "@earendil-works/pi-coding-agent") return current;
		}
		current = path.dirname(current);
	}
	throw new Error(`Could not locate Pi coding-agent package from ${bin}`);
}

async function startLivePi() {
	const codingAgent = process.env.PI_SCHEDULER_PI_PACKAGE || installedPiPackage();
	const sdk = await import(pathToFileURL(path.join(codingAgent, "dist/index.js")));
	const requireFromPi = createRequire(path.join(codingAgent, "package.json"));
	const typebox = process.env.PI_SCHEDULER_TYPEBOX_PACKAGE || requireFromPi.resolve("typebox/value");
	const { Value } = await import(pathToFileURL(typebox));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduler-live-cwd-"));
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduler-live-agent-"));
	const stateFile = path.join(agentDir, "tasks.json");
	const previousOffline = process.env.PI_OFFLINE;
	const previousStateFile = process.env.PI_SCHEDULER_STATE_FILE;
	process.env.PI_OFFLINE = "1";
	process.env.PI_SCHEDULER_STATE_FILE = stateFile;
	let session;
	async function close() {
		try { await session?.extensionRunner?.emit({ type: "session_shutdown" }); }
		finally {
			try { session?.dispose(); }
			finally {
				if (previousOffline === undefined) delete process.env.PI_OFFLINE;
				else process.env.PI_OFFLINE = previousOffline;
				if (previousStateFile === undefined) delete process.env.PI_SCHEDULER_STATE_FILE;
				else process.env.PI_SCHEDULER_STATE_FILE = previousStateFile;
				fs.rmSync(cwd, { recursive: true, force: true });
				fs.rmSync(agentDir, { recursive: true, force: true });
			}
		}
	}
	try {
	const loader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir,
		additionalExtensionPaths: [path.resolve(__dirname, "../../extensions/scheduler/index.ts")],
	});
	await loader.reload();
	const created = await sdk.createAgentSession({
		cwd,
		agentDir,
		noTools: "all",
		resourceLoader: loader,
		sessionManager: sdk.SessionManager.inMemory(cwd),
	});
	session = created.session;
	await session.bindExtensions({});
	const runner = session.extensionRunner;
	const tools = sdk.wrapRegisteredTools(runner.getAllRegisteredTools(), runner);
	return {
		cwd,
		agentDir,
		stateFile,
		session,
		runner,
		tools,
		tool(name) {
			const found = tools.find((tool) => tool.name === name);
			if (!found) throw new Error(`Pi tool not registered: ${name}`);
			return found;
		},
		valid(schema, value) {
			return Value.Check(schema, value);
		},
		close,
	};
	} catch (error) {
		await close();
		throw error;
	}
}

function pathToFileURL(file) {
	return require("node:url").pathToFileURL(file).href;
}

module.exports = { startLivePi };
