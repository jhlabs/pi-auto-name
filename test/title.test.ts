import assert from "node:assert/strict";
import test from "node:test";
import {
	buildTitlePrompt,
	buildTranscript,
	conversationMessages,
	countUserMessages,
	fallbackTitle,
	sanitizeTitle,
	shouldRefreshTitle,
} from "../src/title.ts";

test("sanitizes common model title wrappers", () => {
	assert.equal(sanitizeTitle('## Session title: "Repair Twitter Bookmark Polling."'), "Repair Twitter Bookmark Polling");
	assert.equal(sanitizeTitle("<title>Improve Pi Session Names</title>"), "Improve Pi Session Names");
	assert.equal(sanitizeTitle("\n\n"), undefined);
});

test("truncates long titles at a readable word boundary", () => {
	const title = sanitizeTitle(
		"Diagnose and Repair the Reader Twitter Bookmark Import Pipeline Without Breaking Existing Polling",
		48,
	);
	assert.equal(title, "Diagnose and Repair the Reader Twitter Bookmark…");
	assert.ok(title.length <= 48);
});

test("derives an immediate fallback from the first prompt", () => {
	assert.equal(
		fallbackTitle("Could you please diagnose why bookmark imports are failing? They stopped yesterday."),
		"diagnose why bookmark imports are failing",
	);
	assert.equal(
		fallbackTitle("I want to build an extension that names Pi conversations automatically."),
		"build an extension that names Pi conversations automatically",
	);
});

test("extracts only user and assistant text messages", () => {
	const messages = conversationMessages([
		{ type: "message", message: { role: "user", content: "Fix the importer" } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "secret" },
					{ type: "text", text: "I found the retry bug." },
					{ type: "toolCall", name: "read" },
				],
			},
		},
		{ type: "message", message: { role: "toolResult", content: "large output" } },
	]);

	assert.deepEqual(messages, [
		{ role: "user", text: "Fix the importer" },
		{ role: "assistant", text: "I found the retry bug." },
	]);
	assert.equal(countUserMessages(messages), 1);
});

test("keeps the first user prompt and the latest history within the budget", () => {
	const transcript = buildTranscript(
		[
			{ role: "user", text: "Original goal" },
			{ role: "assistant", text: "x".repeat(200) },
			{ role: "user", text: "Latest direction" },
			{ role: "assistant", text: "Current result" },
		],
		90,
	);

	assert.match(transcript, /^User: Original goal/);
	assert.match(transcript, /Latest direction/);
	assert.match(transcript, /Current result/);
	assert.doesNotMatch(transcript, /x{20}/);
});

test("refreshes once initially and then on the configured message cadence", () => {
	assert.equal(shouldRefreshTitle(0, 0, 3), false);
	assert.equal(shouldRefreshTitle(1, 0, 3), true);
	assert.equal(shouldRefreshTitle(2, 1, 3), false);
	assert.equal(shouldRefreshTitle(4, 1, 3), true);
	assert.equal(shouldRefreshTitle(3, 1, 1), true);
});

test("title prompt requests one specific bounded title", () => {
	const prompt = buildTitlePrompt("User: Fix sync\n\nAssistant: Investigating", "Fix Sync");
	assert.match(prompt, /4 to 10 words/);
	assert.match(prompt, /Current title: Fix Sync/);
	assert.match(prompt, /<conversation>/);
	assert.match(prompt, /User: Fix sync/);
});
