import type { CellSpec, WorkbookModel } from './model.js';
import { columnLetter } from './refs.js';

/**
 * Evaluates the workbook's own formulas.
 *
 * ## Why this exists
 *
 * The first version of the phase 2 tests reconciled the *engine's* series
 * against the identities the formulas were supposed to encode. Reintroducing a
 * sign error on purpose — subtracting free rent where the engine adds it —
 * left all 23 tests passing. They were checking my understanding of the engine,
 * not the formulas actually emitted, which is exactly the kind of test that
 * proves nothing while looking thorough.
 *
 * This evaluates the formula text the exporter produces, resolving references
 * through the same cell registry Excel would resolve them through. A wrong
 * operator now changes a number and the reconciliation test fails.
 *
 * ## What it is not
 *
 * It is not a second calculation engine, and it encodes no business rule: it
 * knows arithmetic, cell references and five spreadsheet functions. It is a
 * test instrument, deliberately kept in the smallest form that can check the
 * workbook — a full Excel implementation would be its own source of bugs.
 *
 * Functions outside its subset (`XIRR`, `XNPV`, `SUMIF`) return `NaN`, and
 * callers skip those cells rather than pretending to have checked them.
 */

interface Located {
  cell: CellSpec;
  sheet: string;
}

export class FormulaEvaluator {
  /** `Sheet!row:col` → the cell placed there. */
  private readonly grid = new Map<string, Located>();
  private readonly cache = new Map<string, number>();
  private readonly evaluating = new Set<string>();
  private readonly names: Map<string, string>;

  constructor(private readonly workbook: WorkbookModel) {
    for (const sheet of workbook.sheets) {
      for (const cell of sheet.cells) {
        this.grid.set(`${sheet.name}!${cell.row}:${cell.col}`, { cell, sheet: sheet.name });
      }
    }
    this.names = new Map(workbook.definedNameEntries().map((entry) => [entry.name, entry.ref]));
  }

  /** Evaluates the cell registered under `key`, or throws if there is none. */
  value(key: string, period?: number): number {
    const address = this.workbook.address(key, period);
    if (!address) throw new Error(`No cell registered under ${key}${period ?? ''}.`);
    return this.at(address.sheet, address.row, address.col);
  }

  at(sheet: string, row: number, col: number): number {
    const id = `${sheet}!${row}:${col}`;
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;

    if (this.evaluating.has(id)) {
      // Excel would report a circular reference; here it is a bug in the
      // exporter and should surface as one.
      throw new Error(`Circular reference at ${sheet}!${columnLetter(col)}${row}.`);
    }

    const located = this.grid.get(id);
    if (!located) return 0; // An empty cell is zero, as in Excel.

    const { cell } = located;
    let result: number;

    if (cell.kind === 'formula') {
      if (!cell.formula) throw new Error(`${id} is a formula cell with no formula.`);
      this.evaluating.add(id);
      try {
        const text = cell.formula(this.workbook.resolver(sheet));
        result = new Parser(text, sheet, this).parse();
      } finally {
        this.evaluating.delete(id);
      }
    } else if (typeof cell.value === 'number') {
      result = cell.value;
    } else {
      // Text and dates are not numbers; treated as zero the way Excel treats
      // text in arithmetic contexts it can ignore.
      result = 0;
    }

    this.cache.set(id, result);
    return result;
  }

  resolveName(name: string): { sheet: string; row: number; col: number } | undefined {
    const ref = this.names.get(name);
    if (ref === undefined) return undefined;
    return parseAddress(ref);
  }
}

/** `'Cash Flow'!$D$7` or `Revenue!D7` or `D7`. */
export function parseAddress(
  ref: string,
  defaultSheet?: string,
): { sheet: string; row: number; col: number } {
  /*
   * Split on the last `!` rather than pattern-matching the sheet name.
   * A sheet name may contain almost anything — `Cash Flow` has a space — and a
   * character class for it will always be missing a case. The cell part after
   * the separator is the only piece with a fixed shape.
   */
  const separator = ref.lastIndexOf('!');
  let sheet = defaultSheet;
  let cell = ref;
  if (separator >= 0) {
    let raw = ref.slice(0, separator);
    if (raw.startsWith("'") && raw.endsWith("'")) {
      raw = raw.slice(1, -1).replace(/''/g, "'");
    }
    sheet = raw;
    cell = ref.slice(separator + 1);
  }
  if (sheet === undefined) throw new Error(`No sheet for the reference "${ref}".`);

  const match = /^\$?([A-Z]+)\$?(\d+)$/.exec(cell);
  if (!match) throw new Error(`Cannot parse the reference "${ref}".`);
  let col = 0;
  for (const character of match[1] as string) col = col * 26 + (character.charCodeAt(0) - 64);
  return { sheet, row: Number(match[2]), col };
}

/**
 * A recursive-descent parser for the formula subset the exporter emits.
 *
 * Grammar, loosest binding first:
 *   expression := term (('+' | '-') term)*
 *   term       := unary (('*' | '/') unary)*
 *   unary      := '-'? power
 *   power      := primary ('^' unary)?
 *   primary    := number | function | reference | '(' expression ')'
 */
class Parser {
  private pos = 0;

  constructor(
    private readonly text: string,
    private readonly sheet: string,
    private readonly evaluator: FormulaEvaluator,
  ) {}

  parse(): number {
    const value = this.expression();
    this.skipSpace();
    if (this.pos < this.text.length) {
      throw new Error(`Unparsed input in "${this.text}" at ${this.pos}.`);
    }
    return value;
  }

  private skipSpace(): void {
    while (this.pos < this.text.length && this.text[this.pos] === ' ') this.pos += 1;
  }

  private expression(): number {
    let value = this.term();
    for (;;) {
      this.skipSpace();
      const character = this.text[this.pos];
      if (character === '+') {
        this.pos += 1;
        value += this.term();
      } else if (character === '-') {
        this.pos += 1;
        value -= this.term();
      } else {
        return value;
      }
    }
  }

  private term(): number {
    let value = this.unary();
    for (;;) {
      this.skipSpace();
      const character = this.text[this.pos];
      if (character === '*') {
        this.pos += 1;
        value *= this.unary();
      } else if (character === '/') {
        this.pos += 1;
        const divisor = this.unary();
        // Excel would show #DIV/0!; the exporter guards these with IF, so
        // reaching one means a guard is missing.
        value = divisor === 0 ? Number.NaN : value / divisor;
      } else {
        return value;
      }
    }
  }

  private unary(): number {
    this.skipSpace();
    if (this.text[this.pos] === '-') {
      this.pos += 1;
      // Excel binds unary minus tighter than `^`: `-2^2` is 4, not -4 — the
      // sign has to land on the *base*, before `^` is applied, not on the
      // result of the whole power expression. `power()` itself consumes the
      // entire `base^exponent`, so `-this.power()` (what this used to do)
      // negates that whole result: for `-2^2` it computes `2^2` = 4 first
      // and only then negates, landing on -4 — the opposite of both this
      // comment and real Excel. Passing the negation into `power()` applies
      // it to the base before `^` sees it instead.
      return this.power(true);
    }
    if (this.text[this.pos] === '+') {
      this.pos += 1;
      return this.unary();
    }
    return this.power(false);
  }

  /** `^` is right-associative and binds tighter than `*` and `/`. `negateBase`
   *  is a leading unary minus applied to the base before exponentiating, not
   *  to the power expression's result — see the comment in `unary()`. */
  private power(negateBase: boolean): number {
    const rawBase = this.primary();
    const base = negateBase ? -rawBase : rawBase;
    this.skipSpace();
    if (this.text[this.pos] === '^') {
      this.pos += 1;
      return base ** this.unary();
    }
    return base;
  }

  private primary(): number {
    this.skipSpace();

    if (this.text[this.pos] === '(') {
      this.pos += 1;
      const value = this.expression();
      this.skipSpace();
      if (this.text[this.pos] !== ')') throw new Error(`Expected ) in "${this.text}".`);
      this.pos += 1;
      return value;
    }

    if (this.text[this.pos] === '"') {
      // A string literal, only ever a fallback like "n/a"; not a number.
      this.pos += 1;
      while (this.pos < this.text.length && this.text[this.pos] !== '"') this.pos += 1;
      this.pos += 1;
      return Number.NaN;
    }

    const number = /^\d+(\.\d+)?/.exec(this.text.slice(this.pos));
    const nextIsRef = /^[A-Z]+\d/.test(this.text.slice(this.pos));
    if (number && !nextIsRef) {
      this.pos += number[0].length;
      return Number(number[0]);
    }

    // A function call, a quoted-sheet reference, a plain reference or a name.
    const call = /^([A-Z][A-Z0-9.]*)\(/.exec(this.text.slice(this.pos));
    if (call) {
      const name = call[1] as string;
      this.pos += call[0].length;
      const args = this.arguments();
      return this.apply(name, args);
    }

    return this.reference();
  }

  /** Argument list, each element either an expression or a range. */
  private arguments(): Array<{ value: number; range?: number[]; raw: string }> {
    const args: Array<{ value: number; range?: number[]; raw: string }> = [];
    let depth = 0;
    let start = this.pos;

    for (;;) {
      const character = this.text[this.pos];
      if (character === undefined) throw new Error(`Unclosed call in "${this.text}".`);
      if (character === '(') depth += 1;
      if (character === ')' && depth === 0) {
        args.push(this.argument(this.text.slice(start, this.pos)));
        this.pos += 1;
        return args;
      }
      if (character === ')') depth -= 1;
      if (character === ',' && depth === 0) {
        args.push(this.argument(this.text.slice(start, this.pos)));
        this.pos += 1;
        start = this.pos;
        continue;
      }
      this.pos += 1;
    }
  }

  private argument(raw: string): { value: number; range?: number[]; raw: string } {
    const trimmed = raw.trim();
    const range = this.rangeValues(trimmed);
    if (range) return { value: range.reduce((sum, item) => sum + item, 0), range, raw: trimmed };
    if (trimmed === '') return { value: 0, raw: trimmed };
    try {
      return { value: new Parser(trimmed, this.sheet, this.evaluator).parse(), raw: trimmed };
    } catch {
      /*
       * Not every argument is arithmetic. An `IF` condition is a comparison,
       * which this parser has no operator for — `IF` handles it from `raw`
       * instead. Failing here would make a well-formed formula unevaluable, so
       * the value is left as NaN and the function decides what to do with it.
       */
      return { value: Number.NaN, raw: trimmed };
    }
  }

  /** Expands `Sheet!A1:D1` into the values it covers, or returns undefined. */
  private rangeValues(text: string): number[] | undefined {
    const match =
      /^(?:'([^']*(?:''[^']*)*)'|([A-Za-z0-9_]+))?!?\$?([A-Z]+\$?\d+):\$?([A-Z]+\$?\d+)$/.exec(
        text,
      );
    if (!match) return undefined;
    const sheet = match[1]?.replace(/''/g, "'") ?? match[2] ?? this.sheet;
    const from = parseAddress(`${sheet}!${(match[3] as string).replace(/\$/g, '')}`);
    const to = parseAddress(`${sheet}!${(match[4] as string).replace(/\$/g, '')}`);

    const values: number[] = [];
    for (let row = from.row; row <= to.row; row += 1) {
      for (let col = from.col; col <= to.col; col += 1) {
        values.push(this.evaluator.at(sheet, row, col));
      }
    }
    return values;
  }

  private reference(): number {
    const match = /^(?:'([^']*(?:''[^']*)*)'!|([A-Za-z_][A-Za-z0-9_]*)!)?\$?([A-Z]+)\$?(\d+)/.exec(
      this.text.slice(this.pos),
    );
    if (match) {
      this.pos += match[0].length;
      const sheet = match[1]?.replace(/''/g, "'") ?? match[2] ?? this.sheet;
      const address = parseAddress(`${sheet}!${match[3]}${match[4]}`);
      return this.evaluator.at(address.sheet, address.row, address.col);
    }

    const name = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(this.text.slice(this.pos));
    if (name) {
      this.pos += name[0].length;
      const target = this.evaluator.resolveName(name[0]);
      if (!target) throw new Error(`Unknown name "${name[0]}" in "${this.text}".`);
      return this.evaluator.at(target.sheet, target.row, target.col);
    }

    throw new Error(`Cannot parse "${this.text}" at ${this.pos}.`);
  }

  private apply(
    name: string,
    args: Array<{ value: number; range?: number[]; raw: string }>,
  ): number {
    switch (name) {
      case 'SUM':
        return args.reduce((sum, arg) => sum + arg.value, 0);
      case 'MAX':
        return Math.max(...args.flatMap((arg) => arg.range ?? [arg.value]));
      case 'MIN':
        return Math.min(...args.flatMap((arg) => arg.range ?? [arg.value]));
      case 'ABS':
        return Math.abs(args[0]?.value ?? 0);
      case 'IF': {
        // The exporter only ever emits equality conditions, e.g. `IF(13=X,a,b)`.
        const condition = args[0]?.raw ?? '';
        const [left, right] = condition.split('=');
        if (left === undefined || right === undefined) return Number.NaN;
        const lhs = new Parser(left, this.sheet, this.evaluator).parse();
        const rhs = new Parser(right, this.sheet, this.evaluator).parse();
        return lhs === rhs ? (args[1]?.value ?? 0) : (args[2]?.value ?? 0);
      }
      case 'IFERROR': {
        // Real Excel semantics: fall back to the second argument whenever the
        // first is an error. `NaN` here means either an actual arithmetic
        // error or a deliberately unimplemented function (XIRR, XNPV, SUMIF);
        // in the latter case the fallback is just as unverifiable as the
        // primary, so it is also NaN when nothing was supplied, and callers
        // keep skipping the cell rather than treating it as checked.
        const value = args[0]?.value ?? Number.NaN;
        if (Number.isFinite(value)) return value;
        return args[1]?.value ?? Number.NaN;
      }
      default:
        // XIRR, XNPV, SUMIF and anything else: not implemented on purpose.
        // Callers skip these rather than treat an unchecked cell as checked.
        return Number.NaN;
    }
  }
}
