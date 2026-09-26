import { ModelError } from './doc';
import { parseInches } from './units';

/**
 * Formulas for variable bindings: numbers, variable ids, + - * / ( ), unary minus,
 * min / max / round / floor / ceil, and inch literals (`3/4in`, `1 1/2in`, `0.5in` → 1/64").
 * Plain numbers are unitless (so `gap / 2` halves a length). Parsed by hand; never `eval`.
 */

export type Expr =
  | { k: 'num'; v: number }
  | { k: 'var'; id: string }
  | { k: 'neg'; a: Expr }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: Expr; b: Expr }
  | { k: 'call'; fn: FnName; args: Expr[] };

const FNS = {
  min: (xs: number[]) => Math.min(...xs),
  max: (xs: number[]) => Math.max(...xs),
  round: (xs: number[]) => Math.round(xs[0]!),
  floor: (xs: number[]) => Math.floor(xs[0]!),
  ceil: (xs: number[]) => Math.ceil(xs[0]!),
};
type FnName = keyof typeof FNS;
const ARITY: Record<FnName, [number, number]> = { min: [1, 99], max: [1, 99], round: [1, 1], floor: [1, 1], ceil: [1, 1] };

export interface Formula {
  src: string;
  ast: Expr;
  /** Variable ids it reads. */
  refs: string[];
}

type Tok = { t: 'num' | 'id' | 'op'; s: string; v?: number; col: number };

// `1 1/2in`, `3/4in`, `0.5in`, `12 in` — whole-token inch literals (not `in…` identifiers).
const INCH = /^(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+|\.\d+)\s*in(?![A-Za-z0-9_])/;
const NUM = /^(\d+(?:\.\d+)?|\.\d+)/;
const ID = /^[A-Za-z_][A-Za-z0-9_]*/;

function tokenize(src: string, fail: (msg: string, col: number) => never): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const ws = /^\s+/.exec(rest);
    if (ws) {
      i += ws[0].length;
      continue;
    }
    const inch = INCH.exec(rest);
    if (inch) {
      const v = parseInches(inch[1]!);
      if (v === null) fail(`bad length "${inch[0]}"`, i);
      out.push({ t: 'num', s: inch[0], v, col: i });
      i += inch[0].length;
      continue;
    }
    const num = NUM.exec(rest);
    if (num) {
      out.push({ t: 'num', s: num[0], v: Number(num[0]), col: i });
      i += num[0].length;
      continue;
    }
    const id = ID.exec(rest);
    if (id) {
      out.push({ t: 'id', s: id[0], col: i });
      i += id[0].length;
      continue;
    }
    if ('+-*/(),'.includes(src[i]!)) {
      out.push({ t: 'op', s: src[i]!, col: i });
      i++;
      continue;
    }
    fail(`unexpected "${src[i]}"`, i);
  }
  return out;
}

const cache = new Map<string, Formula>();

/** Parses a formula; throws ModelError naming the column of the problem. */
export function parseFormula(src: string): Formula {
  const hit = cache.get(src);
  if (hit) return hit;
  const fail = (msg: string, col: number): never => {
    throw new ModelError(`formula "${src}": ${msg} at column ${col + 1}`);
  };
  const toks = tokenize(src, fail);
  let pos = 0;
  const peek = () => toks[pos];
  const end = () => (toks.length ? toks[toks.length - 1]!.col + toks[toks.length - 1]!.s.length : 0);
  const take = (s: string) => {
    if (peek()?.t === 'op' && peek()!.s === s) return pos++, true;
    return false;
  };
  const refs = new Set<string>();

  const expr = (): Expr => {
    let a = term();
    for (let t = peek(); t?.t === 'op' && (t.s === '+' || t.s === '-'); t = peek()) {
      pos++;
      a = { k: 'bin', op: t.s, a, b: term() };
    }
    return a;
  };
  const term = (): Expr => {
    let a = unary();
    for (let t = peek(); t?.t === 'op' && (t.s === '*' || t.s === '/'); t = peek()) {
      pos++;
      a = { k: 'bin', op: t.s, a, b: unary() };
    }
    return a;
  };
  const unary = (): Expr => {
    if (take('-')) return { k: 'neg', a: unary() };
    if (take('+')) return unary();
    return atom();
  };
  const atom = (): Expr => {
    const t = peek();
    if (!t) return fail('formula ends too soon', end());
    pos++;
    if (t.t === 'num') return { k: 'num', v: t.v! };
    if (t.t === 'id') {
      if (take('(')) {
        if (!(t.s in FNS)) fail(`unknown function "${t.s}"`, t.col);
        const fn = t.s as FnName;
        const args: Expr[] = [];
        if (!take(')')) {
          do args.push(expr());
          while (take(','));
          if (!take(')')) fail('missing ")"', peek()?.col ?? end());
        }
        const [lo, hi] = ARITY[fn];
        if (args.length < lo || args.length > hi) fail(`${fn}() takes ${lo === hi ? lo : `${lo}+`} argument${hi === 1 ? '' : 's'}`, t.col);
        return { k: 'call', fn, args };
      }
      if (t.s in FNS) fail(`"${t.s}" is a function — call it like ${t.s}(…)`, t.col);
      refs.add(t.s);
      return { k: 'var', id: t.s };
    }
    if (t.s === '(') {
      const inner = expr();
      if (!take(')')) fail('missing ")"', peek()?.col ?? end());
      return inner;
    }
    return fail(`unexpected "${t.s}"`, t.col);
  };

  const ast = expr();
  if (pos < toks.length) fail(`unexpected "${toks[pos]!.s}"`, toks[pos]!.col);
  const f: Formula = { src, ast, refs: [...refs] };
  if (cache.size > 1000) cache.clear();
  cache.set(src, f);
  return f;
}

/** Evaluates with the given variable values; throws ModelError on unknown ids or a non-finite result. */
export function evalFormula(f: Formula, value: (id: string) => number | undefined): number {
  const run = (e: Expr): number => {
    switch (e.k) {
      case 'num':
        return e.v;
      case 'var': {
        const v = value(e.id);
        if (v === undefined) throw new ModelError(`formula "${f.src}": no variable "${e.id}"`);
        return v;
      }
      case 'neg':
        return -run(e.a);
      case 'bin': {
        const [a, b] = [run(e.a), run(e.b)];
        if (e.op === '/' && b === 0) throw new ModelError(`formula "${f.src}": divides by zero`);
        return e.op === '+' ? a + b : e.op === '-' ? a - b : e.op === '*' ? a * b : a / b;
      }
      case 'call':
        return FNS[e.fn](e.args.map(run));
    }
  };
  const out = run(f.ast);
  if (!Number.isFinite(out)) throw new ModelError(`formula "${f.src}" doesn't give a number`);
  return out;
}

/** The variable id when the formula is just one variable (`cabW`), else null. */
export function bareVariable(f: Formula): string | null {
  return f.ast.k === 'var' ? f.ast.id : null;
}
