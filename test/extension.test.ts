import assert from "node:assert/strict";
import test from "node:test";
import autoNameExtension from "../index.ts";

type Handler = (event: any, ctx: any) => any;

type HarnessOptions = {
	complete?: (model: any, context: any, options: any) => Promise<any>;
};

function createHarness(options: HarnessOptions = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Handler>();
	const flags = new Map<string, unknown>();
	const branch: any[] = [];
	const names: string[] = [];
	let sessionName: string | undefined;
	let leafId: string | null = "leaf-1";
	let completeCalls = 0;
	const model = { provider: "test", id: "title-model" };

	const pi = {
		registerFlag(name: string, config: { default?: unknown }) {
			flags.set(name, config.default);
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		on(event: string, handler: Handler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		appendEntry(customType: string, data: unknown) {
			branch.push({ type: "custom", customType, data });
		},
		getSessionName() {
			return sessionName;
		},
		setSessionName(name: string) {
			sessionName = name;
			names.push(name);
		},
		registerCommand(name: string, config: { handler: Handler }) {
			commands.set(name, config.handler);
		},
	};

	const ctx = {
		hasUI: false,
		ui: {
			notify() {},
			setStatus() {},
		},
		model,
		modelRegistry: {
			find() {
				return model;
			},
			hasConfiguredAuth() {
				return true;
			},
			async complete(modelArg: any, context: any, completeOptions: any) {
				completeCalls += 1;
				if (options.complete) return options.complete(modelArg, context, completeOptions);
				return {
					stopReason: "stop",
					content: [{ type: "text", text: "Repair Twitter Bookmark Imports" }],
				};
			},
		},
		sessionManager: {
			getBranch() {
				return branch;
			},
			getSessionFile() {
				return undefined;
			},
			getLeafId() {
				return leafId;
			},
		},
	};

	autoNameExtension(pi as any);

	return {
		branch,
		ctx,
		names,
		get completeCalls() {
			return completeCalls;
		},
		get sessionName() {
			return sessionName;
		},
		manualRename(name: string) {
			sessionName = name;
		},
		setLeaf(id: string) {
			leafId = id;
		},
		async fire(event: string, payload: Record<string, unknown> = {}) {
			for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
		},
		async command(name: string, args = "") {
			const handler = commands.get(name);
			if (!handler) throw new Error(`Unknown command: ${name}`);
			await handler(args, ctx);
		},
	};
}

function addSettledConversation(branch: any[]) {
	branch.push(
		{ type: "message", message: { role: "user", content: "Please debug bookmark imports" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "I found the polling bug." }] } },
	);
}

test("names immediately from the first prompt, then refines from history", async () => {
	const harness = createHarness();
	await harness.fire("session_start");
	await harness.fire("before_agent_start", { prompt: "Please debug bookmark imports" });
	assert.equal(harness.sessionName, "debug bookmark imports");

	addSettledConversation(harness.branch);
	await harness.fire("agent_settled");
	assert.equal(harness.sessionName, "Repair Twitter Bookmark Imports");
	assert.equal(harness.completeCalls, 1);
});

test("manual session names disable future automatic updates", async () => {
	const harness = createHarness();
	await harness.fire("session_start");
	await harness.fire("before_agent_start", { prompt: "Please debug bookmark imports" });
	harness.manualRename("My Manual Investigation");
	await harness.fire("session_info_changed", { name: "My Manual Investigation" });

	addSettledConversation(harness.branch);
	await harness.fire("agent_settled");
	assert.equal(harness.completeCalls, 0);
	assert.equal(harness.sessionName, "My Manual Investigation");
});

test("tree navigation cancels stale work and allows an immediate new refresh", async () => {
	let resolveFirstCompletion: (value: any) => void = () => {};
	const firstCompletion = new Promise<any>((resolve) => {
		resolveFirstCompletion = resolve;
	});
	let requestCount = 0;
	const harness = createHarness({
		complete: async () => {
			requestCount += 1;
			if (requestCount === 1) return firstCompletion;
			return {
				stopReason: "stop",
				content: [{ type: "text", text: "Current Branch Title" }],
			};
		},
	});
	await harness.fire("session_start");
	await harness.fire("before_agent_start", { prompt: "Please debug bookmark imports" });
	addSettledConversation(harness.branch);

	const staleRefresh = harness.fire("agent_settled");
	await harness.fire("session_before_tree");
	harness.setLeaf("leaf-2");
	await harness.fire("session_tree", { oldLeafId: "leaf-1", newLeafId: "leaf-2" });
	await staleRefresh;

	harness.branch.push(
		{ type: "message", message: { role: "user", content: "Focus on the active branch" } },
		{ type: "message", message: { role: "assistant", content: "Working on the active branch" } },
	);
	await harness.fire("agent_settled");
	assert.equal(harness.sessionName, "Current Branch Title");

	resolveFirstCompletion({
		stopReason: "stop",
		content: [{ type: "text", text: "Stale Branch Title" }],
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(harness.sessionName, "Current Branch Title");
	assert.doesNotMatch(harness.names.join("\n"), /Stale Branch Title/);
});

test("manual rename cancellation cannot overwrite a re-enabled session", async () => {
	let resolveFirstCompletion: (value: any) => void = () => {};
	const firstCompletion = new Promise<any>((resolve) => {
		resolveFirstCompletion = resolve;
	});
	let requestCount = 0;
	const harness = createHarness({
		complete: async () => {
			requestCount += 1;
			if (requestCount === 1) return firstCompletion;
			return { stopReason: "stop", content: [{ type: "text", text: "Fresh Adopted Title" }] };
		},
	});
	await harness.fire("session_start");
	await harness.fire("before_agent_start", { prompt: "Please debug bookmark imports" });
	addSettledConversation(harness.branch);

	const staleRefresh = harness.fire("agent_settled");
	harness.manualRename("Manual Investigation");
	await harness.fire("session_info_changed", { name: "Manual Investigation" });
	await staleRefresh;
	await harness.command("auto-name", "on");
	await harness.fire("agent_settled");
	assert.equal(harness.sessionName, "Fresh Adopted Title");

	resolveFirstCompletion({
		stopReason: "stop",
		content: [{ type: "text", text: "Stale Pre-Rename Title" }],
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(harness.sessionName, "Fresh Adopted Title");
});

test("does not install partial text from a failed model response", async () => {
	const harness = createHarness({
		complete: async () => ({
			stopReason: "error",
			errorMessage: "provider unavailable",
			content: [{ type: "text", text: "Misleading Partial Title" }],
		}),
	});
	await harness.fire("session_start");
	await harness.fire("before_agent_start", { prompt: "Please debug bookmark imports" });
	addSettledConversation(harness.branch);
	await harness.fire("agent_settled");

	assert.equal(harness.sessionName, "debug bookmark imports");
	assert.doesNotMatch(harness.names.join("\n"), /Misleading Partial Title/);
});
