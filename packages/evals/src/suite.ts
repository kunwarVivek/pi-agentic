/**
 * Eval suite loader — fail-closed JSON parsing (same discipline as `unit.json`,
 * ADR-0001 / FR1). A suite file is JSON so it stays zero-dependency.
 *
 * Judges are code, not data: a parsed suite's cases carry a `contract` (schema
 * + rules + an optional `judge: true` flag that a judge stage is expected) but
 * never a `JudgeFn`. Wire the actual judge functions in code after loading.
 */
import { type Contract, type Rules, regexProblem } from "pi-agentic-core";
import type { EvalCase, EvalSuite } from "./runner.ts";

export class EvalSuiteError extends Error {
	readonly problems: string[];
	constructor(problems: string[]) {
		super(`invalid eval suite: ${problems.join("; ")}`);
		this.problems = problems;
	}
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

function parseRules(v: unknown, path: string, p: string[]): Rules | undefined {
	if (v === undefined) return undefined;
	if (!isObj(v)) {
		p.push(`${path} must be an object`);
		return undefined;
	}
	const known = new Set(["forbiddenKeys", "forbiddenPatterns", "maxBytes"]);
	for (const k of Object.keys(v)) if (!known.has(k)) p.push(`${path} has unknown field '${k}'`);
	const rules: Rules = {};
	if (v.forbiddenKeys !== undefined) {
		if (Array.isArray(v.forbiddenKeys) && v.forbiddenKeys.every(isStr)) rules.forbiddenKeys = v.forbiddenKeys;
		else p.push(`${path}.forbiddenKeys must be string[]`);
	}
	if (v.forbiddenPatterns !== undefined) {
		if (Array.isArray(v.forbiddenPatterns) && v.forbiddenPatterns.every(isStr)) {
			rules.forbiddenPatterns = v.forbiddenPatterns;
			v.forbiddenPatterns.forEach((src, i) => {
				const why = regexProblem(src);
				if (why) p.push(`${path}.forbiddenPatterns[${i}] ${why}`);
			});
		} else p.push(`${path}.forbiddenPatterns must be string[]`);
	}
	if (v.maxBytes !== undefined) {
		if (Number.isInteger(v.maxBytes) && (v.maxBytes as number) > 0) rules.maxBytes = v.maxBytes as number;
		else p.push(`${path}.maxBytes must be a positive integer`);
	}
	return rules;
}

function parseContract(v: unknown, path: string, p: string[]): Contract | undefined {
	if (!isObj(v)) {
		p.push(`${path} must be an object`);
		return undefined;
	}
	const known = new Set(["schema", "rules", "judge"]);
	for (const k of Object.keys(v)) if (!known.has(k)) p.push(`${path} has unknown field '${k}'`);
	if (!isObj(v.schema)) p.push(`${path}.schema must be an object`);
	if (v.judge !== undefined && typeof v.judge !== "boolean") p.push(`${path}.judge must be a boolean`);
	const rules = parseRules(v.rules, `${path}.rules`, p);
	if (!isObj(v.schema)) return undefined;
	const contract: Contract = { schema: v.schema };
	if (rules !== undefined) contract.rules = rules;
	if (typeof v.judge === "boolean") contract.judge = v.judge;
	return contract;
}

/** Parse and validate an eval suite from untrusted JSON. Throws EvalSuiteError. */
export function parseSuite(input: unknown): EvalSuite {
	const p: string[] = [];
	if (!isObj(input)) throw new EvalSuiteError(["suite must be an object"]);
	const known = new Set(["name", "cases"]);
	for (const k of Object.keys(input)) if (!known.has(k)) p.push(`unknown field '${k}'`);
	if (!isStr(input.name) || input.name.length === 0) p.push("name is required");
	if (!Array.isArray(input.cases)) p.push("cases must be an array");

	const cases: EvalCase[] = [];
	const seen = new Set<string>();
	if (Array.isArray(input.cases)) {
		input.cases.forEach((raw, i) => {
			const at = `cases[${i}]`;
			if (!isObj(raw)) {
				p.push(`${at} must be an object`);
				return;
			}
			const kk = new Set(["id", "prompt", "contract"]);
			for (const k of Object.keys(raw)) if (!kk.has(k)) p.push(`${at} has unknown field '${k}'`);
			if (!isStr(raw.id) || raw.id.length === 0) p.push(`${at}.id is required`);
			else if (seen.has(raw.id)) p.push(`${at}.id '${raw.id}' is duplicated`);
			else seen.add(raw.id);
			if (!isStr(raw.prompt)) p.push(`${at}.prompt must be a string`);
			const contract = parseContract(raw.contract, `${at}.contract`, p);
			if (isStr(raw.id) && isStr(raw.prompt) && contract) {
				cases.push({ id: raw.id, prompt: raw.prompt, contract });
			}
		});
	}

	if (p.length > 0) throw new EvalSuiteError(p);
	return { name: input.name as string, cases };
}
