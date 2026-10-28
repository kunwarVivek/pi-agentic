/**
 * Handoff gate chain (ADR-0005): schema → rules → judge, first failure stops.
 * The JSON Schema subset supports: type, properties, required, additionalProperties(false),
 * items, enum, const, minLength, maxLength, minimum, maximum, minItems, maxItems, pattern.
 * Any other keyword is rejected (fail closed) so contracts never silently under-validate.
 */
import { canonicalJson } from "./audit.ts";
import { MAX_REGEX_INPUT_LENGTH, regexProblem } from "./regex-safety.ts";

export type JsonSchema = { [k: string]: unknown };

export interface Rules {
	/** Object keys that must not appear anywhere in the artifact. */
	forbiddenKeys?: string[];
	/** Regex sources that must not match the canonical JSON text. */
	forbiddenPatterns?: string[];
	/** Max canonical JSON size in bytes. */
	maxBytes?: number;
}

export interface Contract {
	schema: JsonSchema;
	rules?: Rules;
	judge?: boolean;
}

export type JudgeFn = (artifact: unknown, contract: Contract) => Promise<{ pass: boolean; reason: string }>;

export type GateResult = { pass: true; stages: string[] } | { pass: false; stage: "schema" | "rules" | "judge"; reasons: string[] };

const SUPPORTED = new Set([
	"type", "properties", "required", "additionalProperties", "items", "enum", "const",
	"minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "pattern",
	"description", "title", "$schema",
]);

function typeOf(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
	return typeof v;
}

function typeOk(expected: string, actual: string): boolean {
	return expected === actual || (expected === "number" && actual === "integer");
}

export function validateSchema(schema: JsonSchema, value: unknown, at = "$"): string[] {
	const errs: string[] = [];
	for (const k of Object.keys(schema)) if (!SUPPORTED.has(k)) errs.push(`${at}: unsupported schema keyword '${k}'`);
	// Malformed constraints fail closed: a broken contract must never silently under-validate.
	if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every((r) => typeof r === "string")))
		errs.push(`${at}: 'required' must be an array of strings`);
	if (schema.enum !== undefined && !Array.isArray(schema.enum)) errs.push(`${at}: 'enum' must be an array`);
	if (schema.properties !== undefined && !isSchema(schema.properties)) errs.push(`${at}: 'properties' must be an object`);
	if (schema.items !== undefined && !isSchema(schema.items)) errs.push(`${at}: 'items' must be a schema object`);
	if (errs.length) return errs;

	const t = typeOf(value);
	// Non-finite numbers (NaN/Infinity) are not valid JSON and must never satisfy a numeric schema.
	if (typeof value === "number" && !Number.isFinite(value)) return [`${at}: non-finite number`];
	const type = schema.type;
	if (type !== undefined) {
		const types = Array.isArray(type) ? type : [type];
		if (!types.some((x) => typeof x === "string" && typeOk(x, t))) return [`${at}: expected ${types.join("|")}, got ${t}`];
	}
	if (schema.const !== undefined && canonicalJson(schema.const) !== canonicalJson(value)) errs.push(`${at}: must equal const`);
	if (Array.isArray(schema.enum) && !schema.enum.some((e) => canonicalJson(e) === canonicalJson(value))) {
		errs.push(`${at}: not in enum`);
	}
	if (typeof value === "string") {
		if (typeof schema.minLength === "number" && value.length < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
		if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
		if (typeof schema.pattern === "string") {
			const why = regexProblem(schema.pattern);
			if (why) errs.push(`${at}: schema pattern ${why}`);
			else if (value.length > MAX_REGEX_INPUT_LENGTH) errs.push(`${at}: too long to match pattern`);
			else if (!new RegExp(schema.pattern, "u").test(value)) errs.push(`${at}: does not match pattern`);
		}
	}
	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) errs.push(`${at}: below minimum ${schema.minimum}`);
		if (typeof schema.maximum === "number" && value > schema.maximum) errs.push(`${at}: above maximum ${schema.maximum}`);
	}
	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems} items`);
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
		const items = schema.items;
		if (isSchema(items)) value.forEach((v, i) => errs.push(...validateSchema(items, v, `${at}[${i}]`)));
	}
	if (t === "object") {
		const obj = value as Record<string, unknown>;
		const props = isSchema(schema.properties) ? schema.properties : {};
		if (Array.isArray(schema.required)) {
			for (const r of schema.required) if (typeof r === "string" && !(r in obj)) errs.push(`${at}: missing required '${r}'`);
		}
		for (const [k, v] of Object.entries(obj)) {
			const ps = props[k];
			if (isSchema(ps)) errs.push(...validateSchema(ps, v, `${at}.${k}`));
			else if (schema.additionalProperties === false) errs.push(`${at}: unexpected property '${k}'`);
		}
	}
	return errs;
}

function isSchema(v: unknown): v is JsonSchema {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function collectKeys(v: unknown, out: Set<string>): void {
	if (Array.isArray(v)) for (const x of v) collectKeys(x, out);
	else if (isSchema(v)) for (const [k, x] of Object.entries(v)) {
		out.add(k);
		collectKeys(x, out);
	}
}

export function checkRules(rules: Rules, artifact: unknown): string[] {
	const errs: string[] = [];
	const text = canonicalJson(artifact);
	if (rules.maxBytes !== undefined && Buffer.byteLength(text) > rules.maxBytes) errs.push(`artifact exceeds ${rules.maxBytes} bytes`);
	if (rules.forbiddenKeys?.length) {
		const keys = new Set<string>();
		collectKeys(artifact, keys);
		for (const k of rules.forbiddenKeys) if (keys.has(k)) errs.push(`forbidden key '${k}'`);
	}
	const patterns = rules.forbiddenPatterns ?? [];
	if (patterns.length && text.length > MAX_REGEX_INPUT_LENGTH) {
		errs.push(`artifact exceeds ${MAX_REGEX_INPUT_LENGTH} characters; forbidden patterns cannot be checked safely`);
	} else {
		for (const src of patterns) {
			const why = regexProblem(src);
			if (why) errs.push(`forbidden pattern /${src}/ ${why}`);
			else if (new RegExp(src, "u").test(text)) errs.push(`forbidden pattern /${src}/`);
		}
	}
	return errs;
}

export async function runGates(contract: Contract, artifact: unknown, judge?: JudgeFn): Promise<GateResult> {
	const stages: string[] = [];
	let s: string[];
	try {
		s = validateSchema(contract.schema, artifact);
	} catch (e) {
		return { pass: false, stage: "schema", reasons: [`schema error: ${(e as Error).message}`] };
	}
	if (s.length) return { pass: false, stage: "schema", reasons: s };
	stages.push("schema");
	if (contract.rules) {
		let r: string[];
		try {
			r = checkRules(contract.rules, artifact);
		} catch (e) {
			return { pass: false, stage: "rules", reasons: [`rules error: ${(e as Error).message}`] };
		}
		if (r.length) return { pass: false, stage: "rules", reasons: r };
		stages.push("rules");
	}
	if (contract.judge) {
		if (!judge) return { pass: false, stage: "judge", reasons: ["contract requires judge but none configured"] };
		try {
			const j = await judge(artifact, contract);
			if (!j.pass) return { pass: false, stage: "judge", reasons: [j.reason] };
		} catch (e) {
			return { pass: false, stage: "judge", reasons: [`judge error: ${(e as Error).message}`] };
		}
		stages.push("judge");
	}
	return { pass: true, stages };
}
