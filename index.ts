import { readFileSync } from "node:fs";
import { uuidv7 } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	buildTitlePrompt,
	buildTranscript,
	conversationMessages,
	countUserMessages,
	DEFAULT_UPDATE_EVERY,
	fallbackTitle,
	sanitizeTitle,
	shouldRefreshTitle,
} from "./src/title.ts";

const STATE_TYPE = "pi-auto-name-state";
const STATE_VERSION = 1;
const DEFAULT_MODEL = "active";
const REFRESH_TIMEOUT_MS = 15_000;

type AutoNameState = {
	version: number;
	enabled: boolean;
	lastGeneratedName?: string;
	lastRefreshedUserCount: number;
	lastAttemptedUserCount: number;
	updateEvery: number;
};

type StateEntry = {
	type: string;
	customType?: string;
	data?: unknown;
};

function isStateData(value: unknown): value is Partial<AutoNameState> {
	return Boolean(value) && typeof value === "object";
}

function positiveInteger(value: unknown, fallback: number): number {
	if (typeof value !== "string" && typeof value !== "number") return fallback;
	const parsed = Number.parseInt(String(value), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function initialState(updateEvery: number): AutoNameState {
	return {
		version: STATE_VERSION,
		enabled: true,
		lastRefreshedUserCount: 0,
		lastAttemptedUserCount: 0,
		updateEvery,
	};
}

function restoredState(entries: StateEntry[], updateEvery: number): AutoNameState | undefined {
	const entry = entries
		.filter((candidate) => candidate.type === "custom" && candidate.customType === STATE_TYPE)
		.pop();
	if (!entry || !isStateData(entry.data)) return undefined;
	const data = entry.data;

	return {
		version: STATE_VERSION,
		enabled: typeof data.enabled === "boolean" ? data.enabled : true,
		lastGeneratedName: typeof data.lastGeneratedName === "string" ? data.lastGeneratedName : undefined,
		lastRefreshedUserCount: positiveInteger(data.lastRefreshedUserCount, 0),
		lastAttemptedUserCount: positiveInteger(data.lastAttemptedUserCount, 0),
		updateEvery: positiveInteger(data.updateEvery, updateEvery),
	};
}

function parseModelReference(reference: string): { provider: string; modelId: string } | undefined {
	const separator = reference.indexOf("/");
	if (separator <= 0 || separator === reference.length - 1) return undefined;
	return {
		provider: reference.slice(0, separator),
		modelId: reference.slice(separator + 1),
	};
}

type StoredSessionName =
	| { found: true; name: string | undefined }
	| { found: false };

export function readStoredSessionName(sessionFile: string | undefined): StoredSessionName {
	if (!sessionFile) return { found: false };

	try {
		const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const entry = JSON.parse(lines[index]) as { type?: string; name?: unknown };
			if (entry.type !== "session_info") continue;
			return { found: true, name: typeof entry.name === "string" ? entry.name : undefined };
		}
	} catch {
		// The in-memory session name remains the fallback for ephemeral or transient files.
	}

	return { found: false };
}

export default function autoNameExtension(pi: ExtensionAPI) {
	pi.registerFlag("auto-name-model", {
		type: "string",
		description: "Model used for session titles (provider/model-id; default: active)",
		default: DEFAULT_MODEL,
	});
	pi.registerFlag("auto-name-every", {
		type: "string",
		description: `Refresh after this many additional user messages (default: ${DEFAULT_UPDATE_EVERY})`,
		default: String(DEFAULT_UPDATE_EVERY),
	});

	let state = initialState(DEFAULT_UPDATE_EVERY);
	let nextRequestId = 0;
	let activeRequest:
		| {
				id: number;
				controller: AbortController;
				cancel: () => void;
				clearStatus: () => void;
		  }
		| undefined;

	const cancelRefresh = () => {
		const request = activeRequest;
		if (!request) return;

		activeRequest = undefined;
		request.controller.abort();
		request.cancel();
		request.clearStatus();
	};

	const persistState = () => {
		pi.appendEntry<AutoNameState>(STATE_TYPE, { ...state });
	};

	const setGeneratedName = (name: string, userMessageCount?: number) => {
		state.lastGeneratedName = name;
		if (userMessageCount !== undefined) {
			state.lastRefreshedUserCount = userMessageCount;
			state.lastAttemptedUserCount = userMessageCount;
		}

		if (pi.getSessionName() !== name) pi.setSessionName(name);
		persistState();
	};

	const resolveModel = (ctx: ExtensionContext) => {
		const configured = String(pi.getFlag("auto-name-model") ?? DEFAULT_MODEL).trim();
		if (configured !== "active") {
			const reference = parseModelReference(configured);
			if (reference) {
				const preferred = ctx.modelRegistry.find(reference.provider, reference.modelId);
				if (preferred && ctx.modelRegistry.hasConfiguredAuth(preferred)) return preferred;
			}
		}

		if (ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model)) return ctx.model;
		return undefined;
	};

	const refreshTitle = async (ctx: ExtensionContext, force = false) => {
		if (activeRequest || !state.enabled) return;

		const storedName = readStoredSessionName(ctx.sessionManager.getSessionFile());
		if (storedName.found && storedName.name !== state.lastGeneratedName) {
			state.enabled = false;
			persistState();
			if (ctx.hasUI) ctx.ui.notify("Auto-name paused after a manual session rename", "info");
			return;
		}

		const messages = conversationMessages(ctx.sessionManager.getBranch());
		const userMessageCount = countUserMessages(messages);
		if (userMessageCount === 0) return;
		if (!force && !shouldRefreshTitle(userMessageCount, state.lastRefreshedUserCount, state.updateEvery)) return;
		if (!force && state.lastAttemptedUserCount === userMessageCount) return;

		const transcript = buildTranscript(messages);
		const model = resolveModel(ctx);
		if (!model) {
			if (ctx.hasUI) ctx.ui.notify("Auto-name could not find an authenticated naming model", "warning");
			return;
		}

		const sessionFile = ctx.sessionManager.getSessionFile();
		const leafId = ctx.sessionManager.getLeafId();
		state.lastAttemptedUserCount = userMessageCount;
		persistState();
		const requestId = ++nextRequestId;
		const controller = new AbortController();
		let cancelRequest = () => {};
		const cancellationPromise = new Promise<never>((_resolve, reject) => {
			cancelRequest = () => reject(new Error("auto-name request cancelled"));
		});
		const clearStatus = () => {
			if (ctx.hasUI) ctx.ui.setStatus("auto-name", undefined);
		};
		activeRequest = { id: requestId, controller, cancel: cancelRequest, clearStatus };
		let timedOut = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => {
				timedOut = true;
				controller.abort();
				reject(new Error("auto-name request timed out"));
			}, REFRESH_TIMEOUT_MS);
		});
		if (ctx.hasUI) ctx.ui.setStatus("auto-name", "naming…");

		try {
			const completion = ctx.modelRegistry.complete(
				model,
				{
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: buildTitlePrompt(transcript, pi.getSessionName()),
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{
					maxTokens: 96,
					reasoningEffort: "minimal",
					cacheRetention: "none",
					sessionId: uuidv7(),
					signal: controller.signal,
				},
			);
			const response = await Promise.race([completion, timeoutPromise, cancellationPromise]);

			if (activeRequest?.id !== requestId) return;
			if (response.stopReason === "aborted" || !state.enabled) return;
			if (response.stopReason === "error") {
				throw new Error(response.errorMessage ?? "the naming model returned an error");
			}
			if (response.stopReason !== "stop" && response.stopReason !== "length") {
				throw new Error(`unexpected naming stop reason: ${response.stopReason}`);
			}
			if (
				ctx.sessionManager.getSessionFile() !== sessionFile ||
				ctx.sessionManager.getLeafId() !== leafId
			) return;

			const latestStoredName = readStoredSessionName(sessionFile);
			if (latestStoredName.found && latestStoredName.name !== state.lastGeneratedName) {
				state.enabled = false;
				persistState();
				if (ctx.hasUI) ctx.ui.notify("Auto-name paused after a manual session rename", "info");
				return;
			}

			const generated = response.content
				.filter((content): content is { type: "text"; text: string } => content.type === "text")
				.map((content) => content.text)
				.join("\n");
			const title = sanitizeTitle(generated);
			if (!title) throw new Error("the naming model returned an empty title");

			setGeneratedName(title, userMessageCount);
		} catch (error) {
			if (timedOut) {
				if (ctx.hasUI) ctx.ui.notify("Auto-name timed out after 15 seconds", "warning");
			} else if (!controller.signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Auto-name failed: ${message}`, "warning");
			}
		} finally {
			clearTimeout(timeout);
			if (activeRequest?.id === requestId) {
				activeRequest = undefined;
				clearStatus();
			}
		}
	};

	pi.on("session_start", (_event, ctx) => {
		const updateEvery = positiveInteger(pi.getFlag("auto-name-every"), DEFAULT_UPDATE_EVERY);
		const restored = restoredState(ctx.sessionManager.getBranch(), updateEvery);
		const currentName = pi.getSessionName();

		state = restored ?? initialState(updateEvery);
		if (!restored && currentName) state.enabled = false;
		if (restored?.lastGeneratedName && currentName !== restored.lastGeneratedName) state.enabled = false;

		if (state.enabled && !currentName) {
			const messages = conversationMessages(ctx.sessionManager.getBranch());
			const firstPrompt = messages.find((message) => message.role === "user")?.text;
			const title = firstPrompt ? fallbackTitle(firstPrompt) : undefined;
			if (title) setGeneratedName(title);
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!state.enabled || pi.getSessionName()) return;
		const title = fallbackTitle(event.prompt);
		if (title) setGeneratedName(title);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await refreshTitle(ctx);
	});

	pi.on("session_info_changed", (event) => {
		if (event.name === state.lastGeneratedName) return;
		if (!state.enabled) return;

		cancelRefresh();
		state.enabled = false;
		persistState();
	});

	pi.on("session_before_tree", () => {
		cancelRefresh();
	});

	pi.on("session_tree", () => {
		state.lastRefreshedUserCount = 0;
		state.lastAttemptedUserCount = 0;
		persistState();
	});

	pi.on("session_shutdown", () => {
		cancelRefresh();
	});

	pi.registerCommand("auto-name", {
		description: "Manage automatic session names (status, now, on, off, every N)",
		handler: async (args, ctx) => {
			const [command = "status", value] = args.trim().toLowerCase().split(/\s+/);

			if (command === "on") {
				cancelRefresh();
				state.enabled = true;
				state.lastGeneratedName = pi.getSessionName();
				state.lastRefreshedUserCount = 0;
				state.lastAttemptedUserCount = 0;
				persistState();
				ctx.ui.notify("Automatic session naming enabled", "info");
				return;
			}

			if (command === "off") {
				cancelRefresh();
				state.enabled = false;
				persistState();
				ctx.ui.notify("Automatic session naming disabled", "info");
				return;
			}

			if (command === "now") {
				cancelRefresh();
				state.enabled = true;
				state.lastGeneratedName = pi.getSessionName();
				persistState();
				await refreshTitle(ctx, true);
				return;
			}

			if (command === "every") {
				const interval = positiveInteger(value, 0);
				if (interval === 0) {
					ctx.ui.notify("Usage: /auto-name every <positive number>", "warning");
					return;
				}
				state.updateEvery = interval;
				persistState();
				ctx.ui.notify(`Auto-name will refresh every ${interval} user messages`, "info");
				return;
			}

			if (command !== "status") {
				ctx.ui.notify("Usage: /auto-name [status|now|on|off|every N]", "warning");
				return;
			}

			const status = state.enabled ? "enabled" : "disabled";
			const title = pi.getSessionName() ?? "(unnamed)";
			ctx.ui.notify(
				`Auto-name ${status}; every ${state.updateEvery} user messages; title: ${title}`,
				"info",
			);
		},
	});
}
