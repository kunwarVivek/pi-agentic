/**
 * Static ReDoS screening for contract regexes (pure, no I/O, no timers).
 *
 * One validator shared by the eval suite loader and the gate pipeline. It is a
 * conservative heuristic, not a proof: it rejects shapes known to backtrack
 * catastrophically (nested quantifiers, backreferences) or polynomially
 * (adjacent overlapping unbounded quantifiers like `.*.*x`, `\w+\w+$`).
 * Patterns are always compiled with the `u` flag.
 */

/** Max length of a regex source accepted by {@link regexProblem}. */
export const MAX_PATTERN_LENGTH = 256;
/** Max length (UTF-16 units) of text a gate will match a regex against; longer fails closed. */
export const MAX_REGEX_INPUT_LENGTH = 1_048_576;

interface Atom {
	/** Source text of a single-character atom (literal, escape, class, dot), else undefined for groups. */
	src: string | undefined;
	unbounded: boolean;
}

interface Frame {
	/** Group body contains a quantifier or alternation. */
	risky: boolean;
	prev: Atom | undefined;
}

const QUANT = /^(?:[*+?]|\{\d+(?:,\d*)?\})\??/;

/** Length of the escape sequence starting at `i` (a backslash), and whether it is a backreference. */
function escapeAt(s: string, i: number): { len: number; backref: boolean } {
	const c = s[i + 1] ?? "";
	if (/[1-9]/.test(c)) return { len: 2, backref: true };
	if (c === "k") return { len: s[i + 2] === "<" ? s.indexOf(">", i) - i + 1 : 2, backref: s[i + 2] === "<" };
	if ((c === "p" || c === "P") && s[i + 2] === "{") return { len: s.indexOf("}", i) - i + 1, backref: false };
	if (c === "u") return { len: s[i + 2] === "{" ? s.indexOf("}", i) - i + 1 : 6, backref: false };
	if (c === "x") return { len: 4, backref: false };
	if (c === "c") return { len: 3, backref: false };
	return { len: 2, backref: false };
}

function literalChar(src: string): string | undefined {
	if (src.length === 1 && src !== ".") return src;
	if (src.length === 2 && src[0] === "\\" && /[^A-Za-z0-9]/.test(src[1] as string)) return src[1];
	return undefined;
}

/** Conservative: do two single-character atoms possibly match a common character? */
function overlaps(a: string, b: string): boolean {
	const la = literalChar(a);
	const lb = literalChar(b);
	if (la !== undefined && lb !== undefined) return la === lb;
	if (la !== undefined) return new RegExp(`^(?:${b})$`, "u").test(la);
	if (lb !== undefined) return new RegExp(`^(?:${a})$`, "u").test(lb);
	// Both are sets: scan the BMP plus one astral probe for a shared member (bounded, deterministic).
	const ra = new RegExp(`^(?:${a})$`, "u");
	const rb = new RegExp(`^(?:${b})$`, "u");
	for (let cp = 0; cp <= 0xffff; cp++) {
		if (cp >= 0xd800 && cp <= 0xdfff) continue;
		const ch = String.fromCodePoint(cp);
		if (ra.test(ch) && rb.test(ch)) return true;
	}
	const astral = String.fromCodePoint(0x1f600);
	return ra.test(astral) && rb.test(astral);
}

/** Returns a problem string when `src` is not a safe, compilable pattern; undefined when acceptable. */
export function regexProblem(src: string): string | undefined {
	if (src.length > MAX_PATTERN_LENGTH) return `exceeds ${MAX_PATTERN_LENGTH} characters`;
	try {
		new RegExp(src, "u");
	} catch (e) {
		return `is not a valid regular expression (${(e as Error).message})`;
	}
	const stack: Frame[] = [];
	let cur: Frame = { risky: false, prev: undefined };
	let i = 0;
	while (i < src.length) {
		const c = src[i] as string;
		let atom: Atom | undefined;
		let atomLen = 1;
		if (c === "\\") {
			const e = escapeAt(src, i);
			if (e.backref) return "uses a backreference (ReDoS risk)";
			atomLen = e.len;
			atom = { src: src.slice(i, i + atomLen), unbounded: false };
		} else if (c === "[") {
			let j = i + 1;
			while (j < src.length && src[j] !== "]") j += src[j] === "\\" ? 2 : 1;
			atomLen = j + 1 - i;
			atom = { src: src.slice(i, i + atomLen), unbounded: false };
		} else if (c === "(") {
			stack.push(cur);
			cur = { risky: false, prev: undefined };
			// Skip group prefix like `?:`, `?=`, `?<name>` so `?` is not read as a quantifier.
			const m = /^\(\?(?:<[^>=!]+>|[:=!]|<[=!])/.exec(src.slice(i));
			i += m ? m[0].length : 1;
			continue;
		} else if (c === ")") {
			const body = cur;
			cur = stack.pop() as Frame;
			i++;
			const q = QUANT.exec(src.slice(i));
			const quantified = q !== null && q[0][0] !== "?" && !/^\{\d+\}/.test(q[0]);
			if (quantified && body.risky) return "has a nested quantifier (ReDoS risk)";
			if (q) i += q[0].length;
			if (body.risky || quantified) cur.risky = true;
			cur.prev = { src: undefined, unbounded: false };
			continue;
		} else if (c === "|") {
			cur.risky = true;
			cur.prev = undefined;
			i++;
			continue;
		} else if (c === "^" || c === "$") {
			cur.prev = undefined;
			i++;
			continue;
		} else atom = { src: c, unbounded: false };
		i += atomLen;
		const q = QUANT.exec(src.slice(i));
		if (q) {
			i += q[0].length;
			if (q[0][0] !== "?") cur.risky = true;
			atom.unbounded = q[0][0] === "*" || q[0][0] === "+" || /^\{\d+,\}/.test(q[0]);
		}
		const p = cur.prev;
		if (atom.unbounded && p?.unbounded && p.src !== undefined && atom.src !== undefined && overlaps(p.src, atom.src)) {
			return "has adjacent overlapping unbounded quantifiers (ReDoS risk)";
		}
		cur.prev = atom;
	}
	return undefined;
}
