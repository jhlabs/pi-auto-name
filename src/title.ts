export const DEFAULT_UPDATE_EVERY = 3;
export const MAX_TITLE_LENGTH = 72;
export const MAX_TRANSCRIPT_LENGTH = 12_000;

export type ConversationMessage = {
	role: "user" | "assistant";
	text: string;
};

type ContentBlock = {
	type?: string;
	text?: string;
};

type SessionEntry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateAtWord(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	if (maxLength <= 1) return "…".slice(0, maxLength);

	const contentLength = maxLength - 1;
	const shortened = value.slice(0, contentLength + 1);
	const lastSpace = shortened.lastIndexOf(" ");
	const cutoff = lastSpace >= Math.floor(contentLength * 0.6) ? lastSpace : contentLength;
	return `${shortened.slice(0, cutoff).trimEnd()}…`;
}

export function sanitizeTitle(value: string, maxLength = MAX_TITLE_LENGTH): string | undefined {
	const firstLine = value
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
	if (!firstLine) return undefined;

	const cleaned = collapseWhitespace(
		firstLine
			.replace(/^#{1,6}\s*/, "")
			.replace(/^(?:session\s+)?title\s*:\s*/i, "")
			.replace(/^<title>|<\/title>$/gi, "")
			.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "")
			.replace(/[.!?,;:]+$/g, ""),
	);

	if (cleaned.length < 3) return undefined;
	return truncateAtWord(cleaned, maxLength);
}

export function fallbackTitle(firstPrompt: string): string | undefined {
	let prompt = collapseWhitespace(firstPrompt)
		.replace(/^#{1,6}\s*/, "")
		.replace(/^(?:ok(?:ay)?[,!.]?\s+)?(?:please\s+)?(?:can|could|would)\s+you\s+(?:please\s+)?/i, "")
		.replace(/^(?:ok(?:ay)?[,!.]?\s+)?(?:please\s+)?(?:i(?:'d| would)?\s+like\s+to|i\s+want\s+to|help\s+me\s+to?)\s+/i, "")
		.replace(/^please\s+/i, "");

	const sentenceEnd = prompt.search(/[.!?](?:\s|$)/);
	if (sentenceEnd >= 12) prompt = prompt.slice(0, sentenceEnd);

	return sanitizeTitle(prompt);
}

function extractText(content: unknown): string {
	if (typeof content === "string") return collapseWhitespace(content);
	if (!Array.isArray(content)) return "";

	return collapseWhitespace(
		content
			.filter((block): block is ContentBlock => Boolean(block) && typeof block === "object")
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join(" "),
	);
}

export function conversationMessages(entries: SessionEntry[]): ConversationMessage[] {
	const messages: ConversationMessage[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;

		const text = extractText(entry.message?.content);
		if (text) messages.push({ role, text });
	}

	return messages;
}

export function countUserMessages(messages: ConversationMessage[]): number {
	return messages.filter((message) => message.role === "user").length;
}

function formatMessage(message: ConversationMessage): string {
	const label = message.role === "user" ? "User" : "Assistant";
	return `${label}: ${truncateAtWord(message.text, 1_800)}`;
}

export function buildTranscript(
	messages: ConversationMessage[],
	maxLength = MAX_TRANSCRIPT_LENGTH,
): string {
	if (messages.length === 0) return "";

	const formatted = messages.map(formatMessage);
	const firstUserIndex = messages.findIndex((message) => message.role === "user");
	const first = firstUserIndex >= 0 ? formatted[firstUserIndex] : formatted[0];
	const selected: string[] = [];
	let used = first.length;

	for (let index = formatted.length - 1; index >= 0; index -= 1) {
		if (index === firstUserIndex) continue;
		const section = formatted[index];
		if (used + section.length + 2 > maxLength) continue;
		selected.unshift(section);
		used += section.length + 2;
	}

	if (selected.length === 0 || selected[0] !== first) selected.unshift(first);
	return truncateAtWord(selected.join("\n\n"), maxLength);
}

export function shouldRefreshTitle(
	userMessageCount: number,
	lastRefreshedUserCount: number,
	updateEvery = DEFAULT_UPDATE_EVERY,
): boolean {
	if (userMessageCount === 0) return false;
	if (lastRefreshedUserCount === 0) return true;
	return userMessageCount - lastRefreshedUserCount >= Math.max(1, updateEvery);
}

export function buildTitlePrompt(transcript: string, currentTitle?: string): string {
	return [
		"Create a clear title for this Pi coding-agent conversation.",
		"Return exactly one plain-text title and nothing else.",
		"Requirements:",
		"- 4 to 10 words and no more than 72 characters",
		"- name the concrete subject and current task or outcome",
		"- reflect the conversation overall, emphasizing the latest active goal",
		"- use natural title case",
		"- do not say conversation, session, user, or assistant",
		"- avoid generic titles such as Help With Code or Coding Task",
		currentTitle ? `Current title: ${currentTitle}` : "",
		"",
		"<conversation>",
		transcript,
		"</conversation>",
	]
		.filter(Boolean)
		.join("\n");
}
