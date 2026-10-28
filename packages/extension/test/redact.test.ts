import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACTION, redactSecrets, redactionFound } from "../src/redact.ts";
import { redactJson } from "../src/org-policy.ts";
import type { JsonValue } from "../src/pi-api.ts";

// Fixtures are assembled at runtime so no literal in the repo matches a real
// vendor-token format (GitHub push protection / secret scanners reject those).
const j = (...parts: string[]) => parts.join("");
const secrets: Record<string, string> = {
	"sk-proj": j("sk-", "proj-abcDEF123_ghiJKL456-mnoPQR789stuVWX"),
	"sk-svcacct": j("sk-", "svcacct-abcDEF123_ghiJKL456-mnoPQR789stuVWX"),
	"sk-ant": j("sk-", "ant-api03-abcDEF123_ghiJKL456-mnoPQR789"),
	"sk plain": j("sk-", "abcdefghijklmnopqrstuvwx"),
	xoxe: j("xo", "xe-1-abcdefghijklmnop1234"),
	"xoxe.xoxp": j("xo", "xe.", "xo", "xp-1-abcdefghij1234"),
	xoxb: j("xo", "xb-", "1234567890-abcdefghijkl"),
	AKIA: j("AK", "IA", "IOSFODNN7EXAMPLE"),
	ASIA: j("AS", "IA", "IOSFODNN7EXAMPLE"),
	AROA: j("AR", "OA", "IOSFODNN7EXAMPLE"),
};

for (const [name, secret] of Object.entries(secrets)) {
	test(`redacts ${name}`, () => {
		const out = redactSecrets(`key is ${secret} end`);
		assert.equal(out, `key is ${REDACTION} end`);
		assert.ok(redactionFound(secret));
	});
}

test("redacts sensitive KEY=VALUE, keeping key and quotes", () => {
	assert.equal(redactSecrets("PASSWORD=hunter2hunter"), `PASSWORD=${REDACTION}`);
	assert.equal(redactSecrets(`api_key: "abc"`), `api_key: "${REDACTION}"`);
	assert.equal(redactSecrets("access-key = 123456789012"), `access-key = ${REDACTION}`);
	assert.equal(redactSecrets("db_password=hunter2"), `db_password=${REDACTION}`);
});

test("does not redact benign token-ish keys", () => {
	for (const s of ["tokens: 42", "max_tokens=1000", "token_count: 512", "secret: false", "password: null", "hello: world"]) {
		assert.equal(redactSecrets(s), s, s);
		assert.equal(redactionFound(s), false);
	}
});

test("numeric values are only benign for token-count keys", () => {
	for (const s of ["tokens: 42", "max_tokens=1000", "totalTokens: 9", "input_tokens=12"]) assert.equal(redactSecrets(s), s, s);
	assert.equal(redactSecrets("password=123456"), `password=${REDACTION}`);
	assert.equal(redactSecrets("pin_secret: 0000"), `pin_secret: ${REDACTION}`);
	assert.equal(redactSecrets("api_key=1234567"), `api_key=${REDACTION}`);
	assert.equal(redactSecrets("auth_token=123456"), `auth_token=${REDACTION}`);
});

test("is idempotent", () => {
	const once = redactSecrets(`token=abcdefghijkl ${j("AK", "IA", "IOSFODNN7EXAMPLE")}`);
	assert.equal(redactSecrets(once), once);
});

test("linear on adversarial input", () => {
	const t = Date.now();
	redactSecrets("a".repeat(200000));
	redactSecrets("a_".repeat(100000) + "=");
	redactSecrets("sk-" + "a-".repeat(100000));
	redactSecrets("-".repeat(200000));
	assert.ok(Date.now() - t < 2000);
});

test("linear on hyphen/underscore/equals runs (<200ms each)", () => {
	for (const input of ["a-".repeat(50000), "a_".repeat(50000), "a=".repeat(50000), "a-".repeat(50000) + "=x", " ".repeat(50000) + "=", "=".repeat(50000)]) {
		const t = performance.now();
		redactSecrets(input);
		assert.ok(performance.now() - t < 200, `slow on ${input.slice(0, 6)}`);
	}
});

test("long key still redacts", () => {
	assert.equal(redactSecrets("x".repeat(500) + "password=hunter2"), "x".repeat(500) + `password=${REDACTION}`);
});

test("numeric exemption is a whitelist of count keys", () => {
	for (const k of ["access_token", "csrf_token", "session_token", "auth_token", "access_tokens"]) {
		const out = redactSecrets(`${k}=1234567`);
		assert.equal(out, `${k}=${REDACTION}`, k);
	}
	for (const k of ["tokens", "max_tokens", "input_tokens", "totalTokens", "inputTokens", "outputTokens"]) {
		assert.equal(redactSecrets(`${k}=1234`), `${k}=1234`, k);
	}
	assert.equal(redactSecrets("csrf_token=123456"), `csrf_token=${REDACTION}`);
	assert.equal(redactSecrets("session_token=123"), `session_token=${REDACTION}`);
	assert.equal(redactSecrets("password=true"), "password=true");
});

test("redactJson redacts values of sensitive keys", () => {
	const redacted = (v: JsonValue) => redactJson(v);
	assert.deepEqual(redacted({ password: "hunter2" }), { password: REDACTION });
	assert.deepEqual(redacted({ api_key: "abc" }), { api_key: REDACTION });
	assert.deepEqual(redacted({ access_token: 1234567 }), { access_token: REDACTION });
	assert.deepEqual(redacted({ nested: { secret: ["a", "b"] } }), { nested: { secret: [REDACTION, REDACTION] } });
	const benign = { tokens: 42, max_tokens: 10, password: true, secret: null, name: "x" };
	assert.equal(redactJson(benign), benign);
});
