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

const SENSITIVE_KEY = "(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)";

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
	// Vendor key prefixes: sk-, ghp_/gho_/..., github_pat_, xoxb-/..., AKIA..., AIza...
	{
		re: /\b(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g,
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
		re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi,
		replace: (_m, head, _secret, at) => `${head}${REDACTION}${at}`,
	},
	// KEY=VALUE or KEY: VALUE where KEY looks sensitive. Keep the key and separator.
	{
		re: new RegExp(`\\b([A-Za-z0-9_]*${SENSITIVE_KEY}[A-Za-z0-9_]*\\s*[=:]\\s*)("?)([^\\s"']+)("?)`, "gi"),
		replace: (_m, head, openQuote, _value, closeQuote) => `${head}${openQuote}${REDACTION}${closeQuote}`,
	},
];

export function redactSecrets(input: string): string {
	let out = input;
	for (const { re, replace } of RULES) {
		out = out.replace(re, replace as (substring: string, ...args: unknown[]) => string);
	}
	return out;
}

export function redactionFound(input: string): boolean {
	return redactSecrets(input) !== input;
}
