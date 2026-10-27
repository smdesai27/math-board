/**
 * Tiny, safe math expression compiler for plots (no eval, no Function).
 *
 *   compileExpr("sin(x)^2 + 3x", ["x"])  ->  (vars) => number
 *
 * Grammar: numbers, variables, constants (pi, e, tau), + - * / ^ (right-assoc),
 * unary +/-, parentheses, implicit multiplication ("2x", "3(x+1)", "2pi"),
 * and a fixed function table. Unknown identifiers are errors, so the only
 * things an expression can do are arithmetic on the given variables.
 * Shared by the server (validation) and the browser (sampling).
 */

const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  sec: (v) => 1 / Math.cos(v), csc: (v) => 1 / Math.sin(v), cot: (v) => 1 / Math.tan(v),
  exp: Math.exp, ln: Math.log, log: Math.log10, log2: Math.log2, log10: Math.log10,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sign: Math.sign,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max, pow: Math.pow, atan2: Math.atan2,
  hypot: Math.hypot, mod: (a, b) => ((a % b) + b) % b,
  // Common teaching helpers.
  step: (v) => (v >= 0 ? 1 : 0),
  sinc: (v) => (v === 0 ? 1 : Math.sin(v) / v),
  gauss: (v, mu = 0, sigma = 1) => Math.exp(-((v - mu) ** 2) / (2 * sigma * sigma)) / (sigma * Math.sqrt(2 * Math.PI)),
};
const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI, inf: Infinity };
export const EXPR_FUNCTIONS = Object.keys(FUNCS);
const MAX_LEN = 500;

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z_0-9]*)|(\*\*|[-+*/^(),]))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`unexpected character "${src.slice(i).trim()[0]}" at position ${i + 1}`);
    i = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ t: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: "id", v: m[2] });
    else tokens.push({ t: "op", v: m[3] === "**" ? "^" : m[3] });
  }
  return tokens;
}

/** Compile an expression over the allowed variable names. Throws on any error. */
export function compileExpr(src, vars = ["x"]) {
  if (typeof src !== "string" || !src.trim()) throw new Error("empty expression");
  if (src.length > MAX_LEN) throw new Error(`expression longer than ${MAX_LEN} characters`);
  const tokens = tokenize(src);
  let p = 0;
  const peek = () => tokens[p];
  const isOp = (v) => peek()?.t === "op" && peek().v === v;
  const expect = (v) => { if (!isOp(v)) throw new Error(`expected "${v}"`); p++; };
  // Precedence climbing: expr := term (('+'|'-') term)*
  function expr() {
    let left = term();
    while (isOp("+") || isOp("-")) {
      const op = tokens[p++].v, a = left, b = term();
      left = op === "+" ? (s) => a(s) + b(s) : (s) => a(s) - b(s);
    }
    return left;
  }
  // term := unary (('*'|'/'|implicit) unary)*
  function term() {
    let left = unary();
    for (;;) {
      if (isOp("*") || isOp("/")) {
        const op = tokens[p++].v, a = left, b = unary();
        left = op === "*" ? (s) => a(s) * b(s) : (s) => a(s) / b(s);
      } else if (peek() && (peek().t === "num" || peek().t === "id" || isOp("("))) {
        const a = left, b = power(); // implicit multiplication binds like *
        left = (s) => a(s) * b(s);
      } else return left;
    }
  }
  function unary() {
    if (isOp("-")) { p++; const a = unary(); return (s) => -a(s); }
    if (isOp("+")) { p++; return unary(); }
    return power();
  }
  // power := atom ('^' unary)?   (right-associative; -x^2 = -(x^2))
  function power() {
    const base = atom();
    if (isOp("^")) { p++; const ex = unary(); return (s) => Math.pow(base(s), ex(s)); }
    return base;
  }
  function atom() {
    const tok = tokens[p++];
    if (!tok) throw new Error("unexpected end of expression");
    if (tok.t === "num") { const v = tok.v; return () => v; }
    if (tok.t === "op" && tok.v === "(") { const e = expr(); expect(")"); return e; }
    if (tok.t === "id") {
      const name = tok.v;
      if (isOp("(")) {
        const fn = Object.hasOwn(FUNCS, name) ? FUNCS[name] : undefined;
        if (!fn) throw new Error(`unknown function "${name}" (available: ${EXPR_FUNCTIONS.join(", ")})`);
        p++;
        const args = [];
        if (!isOp(")")) { args.push(expr()); while (isOp(",")) { p++; args.push(expr()); } }
        expect(")");
        if (args.length > 4) throw new Error(`too many arguments to ${name}`);
        return (s) => fn(...args.map((a) => a(s)));
      }
      if (vars.includes(name)) return (s) => s[name];
      if (Object.hasOwn(CONSTS, name)) { const v = CONSTS[name]; return () => v; }
      throw new Error(`unknown name "${name}" (variables: ${vars.join(", ")}; constants: pi, e, tau)`);
    }
    throw new Error(`unexpected "${tok.v}"`);
  }
  const fn = expr();
  if (p < tokens.length) throw new Error(`unexpected "${tokens[p].v}"`);
  return (scope) => { const v = fn(scope); return typeof v === "number" ? v : NaN; };
}
