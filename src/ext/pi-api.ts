/**
 * Minimal local type surface for the subset of the Pi extension API that the
 * org extensions use. ADR-0001: agentic-pi has zero runtime dependencies, and
 * `@earendil-works/pi-coding-agent` is not resolvable from this package, so we
 * describe the structural shape we rely on here. At dev runtime the real `pi`
 * object passed to the factory satisfies these interfaces structurally.
 *
 * These are types only (erased at compile time per `erasableSyntaxOnly`).
 */

export interface ToolResultContent {
	type: "text";
	text: string;
}

export interface ToolResult {
	content: ToolResultContent[];
	details?: string;
	structuredContent?: unknown;
	isError?: boolean;
	terminate?: boolean;
}

/** TypeBox schemas are plain JSON-schema-shaped objects at runtime. */
export type ParameterSchema = Record<string, unknown>;

export interface ToolContext {
	readonly signal?: AbortSignal;
	readonly cwd?: string;
	readonly mode?: "tui" | "rpc" | "json" | "print";
	readonly hasUI?: boolean;
}

export interface RegisterToolSpec {
	name: string;
	label?: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string;
	parameters: ParameterSchema;
	execute(toolCallId: string, params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult>;
}

export interface CommandContext {
	readonly cwd?: string;
	ui?: {
		notify?(message: string): void | Promise<void>;
	};
}

export interface RegisterCommandSpec {
	description: string;
	handler(args: string, ctx: CommandContext): Promise<void> | void;
}

/** tool_call hook: return a block decision or mutate event.input in place. */
export interface ToolCallEvent {
	readonly toolName: string;
	input: Record<string, unknown>;
}

export type ToolCallDecision = { block: true; reason: string } | { block?: false } | void;

/** tool_result hook: content may be replaced for redaction (FR9). */
export interface ToolResultEvent {
	readonly toolName: string;
	content: ToolResultContent[];
	structuredContent?: unknown;
}

export interface SystemPromptOptions {
	sections: Record<string, string>;
}

export interface BeforeAgentStartEvent {
	readonly messageType: "user" | "custom";
	systemPromptOptions: SystemPromptOptions;
}

export interface ProjectTrustEvent {
	readonly cwd: string;
}

export type TrustDecision = {
	trusted: "yes" | "no" | "undecided";
	remember?: boolean;
};

export interface ProviderUsage {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly totalTokens?: number;
	readonly costUsd?: number;
}

export interface TurnEndEvent {
	readonly usage?: ProviderUsage;
}

export interface SessionEvent {
	readonly cwd?: string;
}

export interface HookMap {
	tool_call: (event: ToolCallEvent) => ToolCallDecision | Promise<ToolCallDecision>;
	tool_result: (event: ToolResultEvent) => void | Promise<void>;
	before_agent_start: (event: BeforeAgentStartEvent) => void | Promise<void>;
	project_trust: (event: ProjectTrustEvent) => TrustDecision | Promise<TrustDecision>;
	turn_end: (event: TurnEndEvent) => void | Promise<void>;
	session_start: (event: SessionEvent) => void | Promise<void>;
	session_shutdown: (event: SessionEvent) => void | Promise<void>;
}

export interface ExtensionAPI {
	on<K extends keyof HookMap>(event: K, handler: HookMap[K]): void;
	registerTool(spec: RegisterToolSpec): void;
	registerCommand(name: string, spec: RegisterCommandSpec): void;
}

export type Extension = (pi: ExtensionAPI) => void | Promise<void>;
