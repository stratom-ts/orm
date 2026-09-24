type ParameterReference = Readonly<{
  start: number
  end: number
  index: number
}>

export type PostgresSqlScan = Readonly<{
  requiresCleanup: boolean
  malformed: boolean
  parameters: readonly ParameterReference[]
}>

const TRANSACTION_STARTS = new Set([
  'abort',
  'begin',
  'commit',
  'end',
  'release',
  'rollback',
  'savepoint',
])

const PLAIN_STARTS = new Set([
  'alter',
  'analyze',
  'comment',
  'create',
  'delete',
  'drop',
  'explain',
  'grant',
  'insert',
  'merge',
  'refresh',
  'revoke',
  'select',
  'show',
  'table',
  'truncate',
  'update',
  'vacuum',
  'values',
  'with',
])

const ADVISORY_FUNCTION_RE =
  /^pg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared)?$/

type Statement = {
  words: string[]
  executable: boolean
  advisory: boolean
}

/**
 * Tests whether a character may start an unquoted PostgreSQL word.
 *
 * @param character - Character to test.
 */
function isWordStart(character: string): boolean {
  return /[A-Za-z_]/.test(character)
}

/**
 * Tests whether a character may continue an unquoted PostgreSQL word.
 *
 * @param character - Character to test.
 */
function isWordPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character)
}

/**
 * Reads a dollar-quote delimiter at an SQL offset.
 *
 * @param sql - PostgreSQL SQL text.
 * @param offset - Candidate delimiter offset.
 */
function dollarQuoteDelimiter(sql: string, offset: number): string | undefined {
  const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(offset))
  return match?.[0]
}

/** Reports whether a statement requires a connection cleanup after execution. */
function statementRequiresCleanup(statement: Statement): boolean {
  if (statement.advisory) return true

  const [first, second] = statement.words
  if (!first) return true
  if (TRANSACTION_STARTS.has(first)) return true
  if (first === 'start') return true
  if (first === 'prepare' && second === 'transaction') return true
  if (first === 'set' && second === 'transaction') return true
  return !PLAIN_STARTS.has(first)
}

/** Stateful scanner that keeps each PostgreSQL lexical form in one local method. */
class PostgresSqlScanner {
  readonly #parameters: ParameterReference[] = []
  readonly #statements: Statement[] = []
  #statement: Statement = { words: [], executable: false, advisory: false }
  #pendingAdvisoryCall = false
  #malformed = false
  #index = 0

  constructor(readonly sql: string) {}

  scan(): PostgresSqlScan {
    while (this.#index < this.sql.length && !this.#malformed) {
      const character = this.sql[this.#index]!
      const next = this.sql[this.#index + 1]

      if (character === '\0') {
        this.#malformed = true
      } else if (/\s/.test(character)) {
        this.#index++
      } else if (character === ';') {
        this.#finishStatement()
        this.#index++
      } else if (character === '-' && next === '-') {
        this.#readLineComment()
      } else if (character === '/' && next === '*') {
        this.#readBlockComment()
      } else if (character === "'") {
        this.#readString()
      } else if (character === '"') {
        this.#readQuotedIdentifier()
      } else if (character === '$' && this.#readDollarToken()) {
        continue
      } else if (isWordStart(character)) {
        this.#readWord()
      } else {
        this.#readSymbol(character)
      }
    }

    this.#finishStatement()
    return Object.freeze({
      requiresCleanup:
        this.#malformed ||
        this.#statements.length === 0 ||
        this.#statements.some(statementRequiresCleanup),
      malformed: this.#malformed,
      parameters: Object.freeze(this.#parameters),
    })
  }

  #finishStatement(): void {
    if (this.#statement.executable) this.#statements.push(this.#statement)
    this.#statement = { words: [], executable: false, advisory: false }
    this.#pendingAdvisoryCall = false
  }

  #readLineComment(): void {
    const newline = this.sql.indexOf('\n', this.#index + 2)
    this.#index = newline === -1 ? this.sql.length : newline + 1
  }

  #readBlockComment(): void {
    let depth = 1
    this.#index += 2

    while (this.#index < this.sql.length && depth > 0) {
      if (this.sql[this.#index] === '/' && this.sql[this.#index + 1] === '*') {
        depth++
        this.#index += 2
      } else if (this.sql[this.#index] === '*' && this.sql[this.#index + 1] === '/') {
        depth--
        this.#index += 2
      } else {
        this.#index++
      }
    }

    if (depth > 0) this.#malformed = true
  }

  #readString(): void {
    const escapeString =
      this.#index > 0 &&
      this.sql[this.#index - 1]!.toLowerCase() === 'e' &&
      (this.#index === 1 || !isWordPart(this.sql[this.#index - 2]!))
    this.#markExecutable()
    this.#index++
    let closed = false

    while (this.#index < this.sql.length) {
      if (this.sql[this.#index] === "'" && this.sql[this.#index + 1] === "'") {
        this.#index += 2
      } else if (this.sql[this.#index] === "'") {
        this.#index++
        closed = true
        break
      } else if (
        escapeString &&
        this.sql[this.#index] === '\\' &&
        this.#index + 1 < this.sql.length
      ) {
        this.#index += 2
      } else {
        this.#index++
      }
    }

    if (!closed) this.#malformed = true
  }

  #readQuotedIdentifier(): void {
    this.#markExecutable()
    this.#index++
    let closed = false
    let identifier = ''

    while (this.#index < this.sql.length) {
      if (this.sql[this.#index] === '"' && this.sql[this.#index + 1] === '"') {
        identifier += '"'
        this.#index += 2
      } else if (this.sql[this.#index] === '"') {
        this.#index++
        closed = true
        break
      } else {
        identifier += this.sql[this.#index]
        this.#index++
      }
    }

    if (!closed) this.#malformed = true
    this.#pendingAdvisoryCall = closed && ADVISORY_FUNCTION_RE.test(identifier)
  }

  #readDollarToken(): boolean {
    const delimiter = dollarQuoteDelimiter(this.sql, this.#index)

    if (delimiter) {
      this.#markExecutable()
      const closing = this.sql.indexOf(delimiter, this.#index + delimiter.length)

      if (closing === -1) {
        this.#malformed = true
      } else {
        this.#index = closing + delimiter.length
      }

      return true
    }

    const parameter = /^\$(\d+)/.exec(this.sql.slice(this.#index))
    if (!parameter) return false

    const parameterIndex = Number(parameter[1])

    if (!Number.isSafeInteger(parameterIndex) || parameterIndex < 1) {
      this.#malformed = true
      return true
    }

    this.#markExecutable()

    this.#parameters.push({
      start: this.#index,
      end: this.#index + parameter[0].length,
      index: parameterIndex - 1,
    })

    this.#index += parameter[0].length
    return true
  }

  #readWord(): void {
    const start = this.#index++

    while (this.#index < this.sql.length && isWordPart(this.sql[this.#index]!)) {
      this.#index++
    }

    const word = this.sql.slice(start, this.#index).toLowerCase()
    this.#statement.executable = true
    this.#statement.words.push(word)
    this.#pendingAdvisoryCall = ADVISORY_FUNCTION_RE.test(word)
  }

  #readSymbol(character: string): void {
    this.#statement.executable = true

    if (character === '(' && this.#pendingAdvisoryCall) {
      this.#statement.advisory = true
    }

    this.#pendingAdvisoryCall = false
    this.#index++
  }

  #markExecutable(): void {
    this.#statement.executable = true
    this.#pendingAdvisoryCall = false
  }
}

/**
 * Scans PostgreSQL SQL for parameters, malformed text, and cleanup requirements.
 *
 * @example
 *   const scan = scanPostgresSql('select * from users where id = $1')
 *
 * @param sql - PostgreSQL SQL text.
 */
export function scanPostgresSql(sql: string): PostgresSqlScan {
  return new PostgresSqlScanner(sql).scan()
}
