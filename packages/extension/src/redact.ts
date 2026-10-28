/**
 * Secret redaction for tool_result content (SPEC FR9). Pure string → string so
 * it is fully unit-testable; the org-policy extension wires it into the
 * tool_result hook.
 *
 * Strategy: match high-signal secret shapes (API keys, tokens, private key
 * blocks, connection strings with passwords, and KEY=VALUE pairs whose key name
 * looks sensitive). Replace only the secret span with a fixed marker so the
 * length of the secret is not leaked and surrounding context is preserved.
 */

export const REDACTION = "[REDACTED]";

const SENSITIVE_KEY = /pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential/i;

/** Bare literals that are never secrets, for any key. */
const BENIGN_LITERAL = /^(?:true|false|null|none|undefined|nil)$/i;
/** Count-style token keys: `tokens`, `max_tokens`, `*_tokens`, `totalTokens`, `inputTokens`, ... */
const COUNT_KEY = /(?:^|[_-])tokens$|[a-z]Tokens$|^token[_-]?count$/;
/** Credential-ish prefixes that veto the count exemption (`access_tokens`, `authTokens`). */
const NOT_COUNT_KEY = /pass|secret|api[_-]?key|access|private|credential|auth|session|csrf|refresh|bearer|id[_-]?token/i;
const SHORT_NUMBER = /^\d{1,7}$/;

/** True when a key name suggests its value is a credential. */
export function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY.test(key);
}

/** True for count-style keys whose plain numeric values are not secrets. */
export function isTokenCountKey(key: string): boolean {
	return COUNT_KEY.test(key) && !NOT_COUNT_KEY.test(key);
}

/**
 * Shared classifier: should the value under `key` be redacted? Booleans, null and
 * bare literals are never secrets; plain numbers survive only under count-style keys.
 */
export function shouldRedactValue(key: string, value: string | number | boolean | null): boolean {
	if (!isSensitiveKey(key)) return false;
	if (value === null || typeof value === "boolean") return false;
	const text = String(value);
	if (BENIGN_LITERAL.test(text)) return false;
	if (SHORT_NUMBER.test(text) && isTokenCountKey(key)) return false;
	return true;
}

const KEY_CHAR = /[A-Za-z0-9_-]/;

/** Maximal key-char run ending just before the separator at `sepIndex` (whitespace skipped). Linear overall. */
function keyBefore(input: string, sepIndex: number): string {
	let end = sepIndex;
	while (end > 0 && /\s/.test(input[end - 1] as string)) end--;
	let start = end;
	while (start > 0 && KEY_CHAR.test(input[start - 1] as string)) start--;
	return input.slice(start, end);
}

/**
 * KEY=VALUE / KEY: VALUE where KEY looks sensitive. Anchored on the separator
 * (no leading key regex) so cost is linear in input length; the key is found by
 * a backward scan over a run that no other separator's scan can overlap.
 */
const KV_RE = /([=:])\s*("?)([^\s"']+)/g;

function redactKeyValues(input: string): string {
	let out = "";
	let last = 0;
	for (const m of input.matchAll(KV_RE)) {
		const whole = m[0];
		const value = m[3] as string;
		const sepIndex = m.index as number;
		if (value.startsWith(REDACTION)) continue;
		const key = keyBefore(input, sepIndex);
		if (!key || !shouldRedactValue(key, value)) continue;
		const valueStart = sepIndex + whole.length - value.length;
		out += input.slice(last, valueStart) + REDACTION;
		last = valueStart + value.length;
	}
	return last === 0 ? input : out + input.slice(last);
}

/** Each rule is a global regex plus a replacer that keeps non-secret groups. */
interface Rule {
	re: RegExp;
	replace: (match: string, ...groups: string[]) => string;
}

const RULES: Rule[] = [
	// PEM private key blocks — redact the whole block.
	{
		re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
		replace: () => REDACTION,
	},
	// Vendor key prefixes: sk-/sk-proj-/sk-svcacct-/sk-ant-, ghp_/gho_/..., github_pat_,
	// xox?-/xoxe-/xoxe.xox?-, AWS AKIA/ASIA/... access key ids, AIza...
	{
		re: /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xoxe\.xox[a-z]-[A-Za-z0-9-]{10,}|xox[a-z]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[0-9A-Z]{16}\b|AIza[0-9A-Za-z_-]{20,})/g,
		replace: () => REDACTION,
	},
	// JWTs: three base64url segments.
	{
		re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
		replace: () => REDACTION,
	},
	// Bearer token: keep the "Bearer " prefix, redact the credential.
	{
		re: /\b([Bb]earer\s+)[A-Za-z0-9._-]{12,}/g,
		replace: (_m, prefix) => `${prefix}${REDACTION}`,
	},
	// URL inline credentials: scheme://user:secret@host — redact only the secret.
	{
		re: /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi,
		replace: (_m, head, _secret, at) => `${head}${REDACTION}${at}`,
	},
	// KEY=VALUE handled by redactKeyValues (linear, runs after the rules below).
];

export function redactSecrets(input: string): string {
	let out = input;
	for (const { re, replace } of RULES) {
		out = out.replace(re, replace as (substring: string, ...args: unknown[]) => string);
	}
	return redactKeyValues(out);
}

export function redactionFound(input: string): boolean {
	return redactSecrets(input) !== input;
}
