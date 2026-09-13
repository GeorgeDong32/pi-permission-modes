/**
 * Embedded-command extraction for fusion tools (plan2 B1).
 *
 * Tools like SoL-Pi's Action Fusion accept shell commands inside otherwise
 * harmless-looking inputs (`then_run` after an edit). Those commands never
 * go through the bash tool dispatch, so the bash tier ladder never sees
 * them. This module is the single seam that surfaces them to the tool_call
 * gate: scan by FIELD, not by tool name — an override may reuse a built-in
 * name (e.g. an "edit" that also runs `then_run`), and unknown names must
 * be covered too.
 *
 * The gate is deliberately lazy: inputs without whitelist fields yield []
 * and the gate is a no-op (unknown tools without command fields stay on
 * their adjudicated silent-passthrough behavior — pinned by characterization
 * tests). The only name-based rule: the PRIMARY command field of the two
 * shell tools themselves (`bash`/`powershell` `input.command`) is already
 * governed end-to-end by the bash tier ladder and must not be double-handled.
 */

/** Fields whose values are treated as embedded shell commands (user adjudication
 *  2026-09-13: SoL-Pi uses then_run; `script` is deliberately excluded until
 *  measured against real tool schemas — it has false-positive risk). */
const COMMAND_FIELDS = ["then_run", "run", "command", "cmd"] as const;

export interface EmbeddedCommandInput {
	field: string
	command: string
}

const PRIMARY_SHELL_TOOLS = new Set(["bash", "powershell"])

function isCommandFieldExcluded(toolName: string, field: string): boolean {
	// The shell tool's own `command` input IS the primary command — the mode
	// dispatch already runs it through isSafeCommand/classifyBashTiers.
	return field === "command" && PRIMARY_SHELL_TOOLS.has(toolName)
}

/** Table-driven: whitelist fields of the top-level input object, in whitelist
 *  order, then input-key order. Values may be a string or a string[]; empty
 *  strings are skipped. Nested objects are NOT scanned (fields inside child
 *  objects are not commands any real fusion tool ships today). */
export function extractEmbeddedCommandInputs(
	toolName: string,
	input: Record<string, unknown> | null | undefined,
): EmbeddedCommandInput[] {
	if (!input || typeof input !== "object") return []
	const found: EmbeddedCommandInput[] = []
	for (const field of COMMAND_FIELDS) {
		if (isCommandFieldExcluded(toolName, field)) continue
		if (!(field in input)) continue
		const value = input[field]
		const values = Array.isArray(value) ? value : [value]
		for (const v of values) {
			if (typeof v !== "string") continue
			const command = v.trim()
			if (!command) continue
			found.push({ field, command })
		}
	}
	return found
}

/** Whitelist fields declared in a tool's parameter schema (TypeBox object
 *  shape) — used by the session_start annotation to flag fusion-capable
 *  tools from their getAllTools() metadata. */
export function declaredCommandFields(parameters: unknown): string[] {
	const props = (parameters as { properties?: Record<string, unknown> } | null | undefined)
		?.properties
	if (!props || typeof props !== "object") return []
	return COMMAND_FIELDS.filter((field) => field in props)
}
