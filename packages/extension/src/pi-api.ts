/**
 * Minimal local type surface for the subset of the Pi extension API that the
 * org extensions use. ADR-0001: agentic-pi has zero runtime dependencies, and
 * `@earendil-works/pi-coding-agent` is not resolvable from this package, so we
 * describe the structural subset we rely on here, mirroring Pi 1.4.0's
 * `core/extensions/types.d.ts` (handlers receive `(event, ctx)`; tool `execute`
 * takes `(id, params, signal, onUpdate, ctx)`; `label` is required).
 *
 * These are types only (erased at compile time per `erasableSyntaxOnly`).
 */

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export type ToolResultContent = TextContent | ImageContent;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ToolResult {
	content: ToolResultContent[];
	details?: unknown;
	structuredContent?: JsonValue;
	isError?: boolean;
	terminate?: boolean;
}

/** TypeBox schemas are plain JSON-schema-shaped objects at runtime. */
export type ParameterSchema = Record<string, unknown>;

export interface ExtensionUIContext {
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Context passed as the last argument of every event handler. */
export interface ExtensionContext {
	readonly ui: ExtensionUIContext;
	readonly mode: "tui" | "rpc" | "json" | "print";
	readonly hasUI: boolean;
	readonly cwd: string;
	readonly signal?: AbortSignal;
	/** Abort the current agent operation. The only reliable way to stop work from a hook. */
	abort(): void;
	shutdown(): void;
	isIdle(): boolean;
}

export type ExtensionToolContext = ExtensionContext;
export type ExtensionCommandContext = ExtensionContext;

export type ToolUpdateCallback = (partial: ToolResult) => void;

export interface RegisterToolSpec {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: ParameterSchema;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ToolUpdateCallback | undefined,
		ctx: ExtensionToolContext,
	): Promise<ToolResult>;
}

export interface RegisterCommandSpec {
	description?: string;
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

/** tool_call hook: return a block decision or mutate event.input in place. */
export interface ToolCallEvent {
	readonly type?: "tool_call";
	readonly toolCallId?: string;
	readonly toolName: string;
	input: Record<string, unknown>;
}

export interface ToolCallDecision {
	block?: boolean;
	reason?: string;
	terminate?: boolean;
}

/** tool_result hook event (a shallow copy: mutating it has no effect, RETURN a patch). */
export interface ToolResultEvent {
	readonly type?: "tool_result";
	readonly toolCallId?: string;
	readonly toolName: string;
	readonly input?: Record<string, unknown>;
	readonly content: ToolResultContent[];
	readonly structuredContent?: JsonValue;
	readonly isError?: boolean;
	readonly details?: unknown;
}

/** Returning `content` without `structuredContent` drops structuredContent, so return both. */
export interface ToolResultEventResult {
	content?: ToolResultContent[];
	details?: unknown;
	structuredContent?: JsonValue;
	isError?: boolean;
}

export interface SystemPromptOptions {
	sections: Record<string, string>;
}

export interface BeforeAgentStartEvent {
	readonly systemPromptOptions: SystemPromptOptions;
}

/** Custom message a before_agent_start handler may inject (Pi: user-visible when `display`). */
export interface BeforeAgentStartResult {
	message?: { customType: string; content: string; display: boolean; details?: unknown };
}

export interface ProjectTrustEvent {
	readonly cwd: string;
}

export type TrustDecision = {
	trusted: "yes" | "no" | "undecided";
	remember?: boolean;
};

/** Pi AI `Usage` as carried on assistant messages. */
export interface Usage {
	readonly input?: number;
	readonly output?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly totalTokens?: number;
	readonly cost?: {
		readonly input?: number;
		readonly output?: number;
		readonly cacheRead?: number;
		readonly cacheWrite?: number;
		readonly total?: number;
	};
}

/** Subset of AgentMessage: only assistant messages carry `usage`. */
export interface AgentMessage {
	readonly role: string;
	readonly usage?: Usage;
}

export interface TurnStartEvent {
	readonly turnIndex?: number;
	/** Epoch milliseconds. */
	readonly timestamp: number;
}

export interface TurnEndEvent {
	readonly turnIndex?: number;
	readonly message: AgentMessage;
}

export interface SessionEvent {
	readonly cwd?: string;
}

export interface HookMap {
	tool_call: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallDecision | void | Promise<ToolCallDecision | void>;
	tool_result: (event: ToolResultEvent, ctx: ExtensionContext) => ToolResultEventResult | void | Promise<ToolResultEventResult | void>;
	before_agent_start: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => BeforeAgentStartResult | void | Promise<BeforeAgentStartResult | void>;
	project_trust: (event: ProjectTrustEvent, ctx: Pick<ExtensionContext, "cwd" | "mode" | "hasUI" | "ui">) => TrustDecision | Promise<TrustDecision>;
	turn_start: (event: TurnStartEvent, ctx: ExtensionContext) => void | Promise<void>;
	turn_end: (event: TurnEndEvent, ctx: ExtensionContext) => void | Promise<void>;
	session_start: (event: SessionEvent, ctx: ExtensionContext) => void | Promise<void>;
	session_shutdown: (event: SessionEvent, ctx: ExtensionContext) => void | Promise<void>;
}

export interface ExtensionAPI {
	/** Returns an unsubscribe function. */
	on<K extends keyof HookMap>(event: K, handler: HookMap[K]): () => void;
	registerTool(spec: RegisterToolSpec): void;
	registerCommand(name: string, spec: RegisterCommandSpec): void;
}

export type Extension = (pi: ExtensionAPI) => void | Promise<void>;
