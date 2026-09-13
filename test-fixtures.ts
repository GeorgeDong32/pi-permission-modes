/**
 * Shared SessionEntry fixtures (plan2 C1).
 *
 * One factory for the real pi 0.80+ wrapped shapes so unit and integration
 * tests cannot drift into a second fantasy shape (round-1 B1 lesson: a
 * test-local "tool" role hid a dead injection probe).
 */
import type { BranchEntry } from "./session-branch.ts"

/** Wrapped message entry ({type:"message", message:{role, content, ...}}). */
export function msg(
	role: "user" | "assistant" | "toolResult",
	content: unknown,
	extra: Record<string, unknown> = {},
): BranchEntry {
	return { type: "message", id: `e-${role}`, message: { role, content, ...extra } }
}

/** Assistant entry carrying one toolCall content item with usage (pi shape). */
export function assistantToolCallMsg(
	toolName: string,
	args: Record<string, unknown>,
): BranchEntry {
	return {
		type: "message",
		id: "e-assistant",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name: toolName, arguments: args }],
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.01 },
			},
		},
	}
}

/** toolResult entry with a single text part. */
export function toolResultMsg(
	toolName: string,
	toolCallId: string,
	text: string,
): BranchEntry {
	return msg("toolResult", [{ type: "text", text }], { toolName, toolCallId })
}

/** Custom entry (mode-state persistence shape). */
export function customMsg(customType: string, data: unknown): BranchEntry {
	return { type: "custom", customType, data }
}
