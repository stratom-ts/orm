/** Trims only the whitespace accepted by SQLite's SQL tokenizer. */
function trimSqliteWhitespace(value: string): string {
  return value.replace(/^[ \t\r\n\f]+|[ \t\r\n\f]+$/g, '')
}

/** Recognizes supported native literals without rewriting their SQL or storage class. */
function isSqliteDefaultLiteral(value: string): boolean {
  return /^(?:null|true|false|[+-]?[ \t\r\n\f]*(?:0x[\da-f]{1,16}|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)|x'(?:[\da-f]{2})*'|'(?:[^'\0]|'')*')$/i.test(
    trimSqliteWhitespace(value),
  )
}

// Only scalar functions available at the SQLite 3.37 floor belong here. In particular,
// min/max need two arguments; their one-argument forms are aggregate functions.
const functions: Readonly<Record<string, readonly [number, number]>> = {
  abs: [1, 1],
  char: [0, 127],
  coalesce: [2, 127],
  date: [0, 127],
  datetime: [0, 127],
  hex: [1, 1],
  ifnull: [2, 2],
  instr: [2, 2],
  julianday: [0, 127],
  length: [1, 1],
  lower: [1, 1],
  ltrim: [1, 2],
  max: [2, 127],
  min: [2, 127],
  nullif: [2, 2],
  printf: [1, 127],
  quote: [1, 1],
  replace: [3, 3],
  round: [1, 2],
  rtrim: [1, 2],
  sign: [1, 1],
  strftime: [1, 127],
  substr: [2, 3],
  substring: [2, 3],
  time: [0, 127],
  trim: [1, 2],
  unicode: [1, 1],
  upper: [1, 1],
}

const binaryOperator = /^(?:\|\||<<|>>|<=|>=|<>|!=|==|[=<>+*/%&|-])$/
const token =
  /[ \t\r\n\f]*(x'(?:[\da-f]{2})*'|'(?:[^'\0]|'')*'|0x[\da-f]{1,16}(?![\w\u0080-\uffff])|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?![\w\u0080-\uffff])|[a-z_][a-z_\d]*|\|\||<<|>>|<=|>=|<>|!=|==|[(),=<>+*/%&|~-])/iy

/** Proves the syntax and call signatures of a bounded constant-expression subset. */
function isSqliteDefaultExpression(value: string): boolean {
  const tokens: string[] = []
  let offset = 0

  while (offset < value.length) {
    if (/^[ \t\r\n\f]*(?:--|\/\*|\*\/)/.test(value.slice(offset))) return false

    token.lastIndex = offset
    const match = token.exec(value)

    if (!match || tokens.length === 256) return false

    tokens.push(match[1])
    offset = token.lastIndex
  }

  const parser = new DefaultParser(tokens)
  return parser.expression(0) && parser.position === tokens.length
}

/** Parses constant SQL without executing the database or accepting identifiers. */
class DefaultParser {
  position = 0

  constructor(private readonly tokens: readonly string[]) {}

  /** Consumes one expected punctuation or keyword token. */
  private consume(value: string): boolean {
    if (this.tokens[this.position]?.toLowerCase() !== value) return false

    this.position++
    return true
  }

  /** Parses operands separated by supported binary operators. */
  expression(depth: number): boolean {
    if (depth > 24 || !this.operand(depth + 1)) return false

    while (binaryOperator.test(this.tokens[this.position] ?? '')) {
      this.position++

      if (!this.operand(depth + 1)) return false
    }

    return true
  }

  /** Parses literals, unary operators, parentheses, CAST and scalar calls. */
  private operand(depth: number): boolean {
    const value = this.tokens[this.position++]

    if (!value || depth > 24) return false
    if (/^[+~-]$/.test(value)) return this.operand(depth + 1)
    if (value === '(') return this.expression(depth) && this.consume(')')
    if (isSqliteDefaultLiteral(value)) return true
    if (/^current_(timestamp|date|time)$/i.test(value)) return true
    if (!this.consume('(')) return false
    if (value.toLowerCase() === 'cast') return this.cast(depth)

    return this.call(value.toLowerCase(), depth)
  }

  /** Parses CAST with the five supported SQLite storage-affinity targets. */
  private cast(depth: number): boolean {
    if (!this.expression(depth) || !this.consume('as')) return false

    const type = this.tokens[this.position++]
    return /^(?:blob|integer|numeric|real|text)$/i.test(type) && this.consume(')')
  }

  /** Requires complete arguments and a supported scalar function's exact arity. */
  private call(name: string, depth: number): boolean {
    const arity = Object.hasOwn(functions, name) ? functions[name] : undefined

    if (!arity) return false

    const argumentStart = this.position
    const count = this.consume(')') ? 0 : this.arguments(depth)

    return (
      count >= arity[0] &&
      count <= arity[1] &&
      (name !== 'abs' ||
        safeAbsOperand(this.tokens.slice(argumentStart, this.position - 1)))
    )
  }

  /** Counts complete comma-separated arguments and consumes the closing delimiter. */
  private arguments(depth: number): number {
    let count = 0

    do {
      if (!this.expression(depth)) return -1

      count++
    } while (this.consume(','))

    return this.consume(')') ? count : -1
  }
}

/** Proves ABS cannot receive the overflowing minimum integer for a small operand subset. */
function safeAbsOperand(tokens: readonly string[]): boolean {
  if (safeAdditiveIntegers(tokens)) return true

  let operand = tokens

  while (operand.length > 1) {
    if (/^[+-]$/.test(operand[0])) operand = operand.slice(1)
    else if (enclosingParens(operand)) operand = operand.slice(1, -1)
    else break
  }

  if (operand.length === 1) {
    const literal = operand[0]
    return isSqliteDefaultLiteral(literal) && !/^(?:\d+|0x[\da-f]+)$/i.test(literal)
  }

  if (!enclosingParens(operand.slice(1))) return false

  const name = operand[0].toLowerCase()

  if (name === 'cast') return /^(?:real|text|blob)$/i.test(operand.at(-2)!)

  return /^(?:abs|char|date|datetime|hex|instr|julianday|length|lower|ltrim|printf|quote|replace|round|rtrim|sign|strftime|substr|substring|time|trim|unicode|upper)$/.test(
    name,
  )
}

/** Bounds integer addition/subtraction by the sum of each literal's absolute magnitude. */
function safeAdditiveIntegers(tokens: readonly string[]): boolean {
  let magnitude = 0n

  for (const value of tokens) {
    if (/^[()+-]$/.test(value)) continue
    if (!/^(?:\d+|0x[\da-f]+)$/i.test(value)) return false

    magnitude += BigInt(value)
  }

  return magnitude < 9223372036854775808n
}

/** Checks that the first parentheses enclose the entire operand, rather than a prefix. */
function enclosingParens(tokens: readonly string[]): boolean {
  if (tokens[0] !== '(' || tokens.at(-1) !== ')') return false

  let depth = 0

  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === '(') depth++
    if (tokens[index] === ')') depth--
    if (depth === 0 && index < tokens.length - 1) return false
  }

  return depth === 0
}

export { trimSqliteWhitespace, isSqliteDefaultLiteral, isSqliteDefaultExpression }
