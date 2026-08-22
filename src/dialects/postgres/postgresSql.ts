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

/**
 * Scans PostgreSQL SQL for parameters, malformed text, and cleanup requirements.
 *
 * @example
 *   const scan = scanPostgresSql('select * from users where id = $1')
 *
 * @param sql - PostgreSQL SQL text.
 */
export function scanPostgresSql(sql: string): PostgresSqlScan {
  const parameters: ParameterReference[] = []
  const statements: Statement[] = []
  let statement: Statement = { words: [], executable: false, advisory: false }
  let pendingAdvisoryCall = false
  let malformed = false
  let index = 0

  /** Finalizes the current executable statement and resets scanner state. */
  const finishStatement = () => {
    if (statement.executable) statements.push(statement)
    statement = { words: [], executable: false, advisory: false }
    pendingAdvisoryCall = false
  }

  while (index < sql.length) {
    const character = sql[index]!
    const next = sql[index + 1]

    if (character === '\0') {
      malformed = true
      break
    }

    if (/\s/.test(character)) {
      index++
      continue
    }

    if (character === ';') {
      finishStatement()
      index++
      continue
    }

    if (character === '-' && next === '-') {
      const newline = sql.indexOf('\n', index + 2)
      index = newline === -1 ? sql.length : newline + 1
      continue
    }

    if (character === '/' && next === '*') {
      let depth = 1
      index += 2

      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth++
          index += 2
        } else if (sql[index] === '*' && sql[index + 1] === '/') {
          depth--
          index += 2
        } else {
          index++
        }
      }

      if (depth > 0) malformed = true
      continue
    }

    if (character === "'") {
      const escapeString =
        index > 0 &&
        sql[index - 1]!.toLowerCase() === 'e' &&
        (index === 1 || !isWordPart(sql[index - 2]!))
      statement.executable = true
      pendingAdvisoryCall = false
      index++
      let closed = false

      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2
        } else if (sql[index] === "'") {
          index++
          closed = true
          break
        } else if (escapeString && sql[index] === '\\' && index + 1 < sql.length) {
          index += 2
        } else {
          index++
        }
      }

      if (!closed) malformed = true
      continue
    }

    if (character === '"') {
      statement.executable = true
      pendingAdvisoryCall = false
      index++
      let closed = false
      let identifier = ''

      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          identifier += '"'
          index += 2
        } else if (sql[index] === '"') {
          index++
          closed = true
          break
        } else {
          identifier += sql[index]
          index++
        }
      }

      if (!closed) malformed = true
      pendingAdvisoryCall = closed && ADVISORY_FUNCTION_RE.test(identifier)
      continue
    }

    if (character === '$') {
      const delimiter = dollarQuoteDelimiter(sql, index)

      if (delimiter) {
        statement.executable = true
        pendingAdvisoryCall = false
        const closing = sql.indexOf(delimiter, index + delimiter.length)

        if (closing === -1) {
          malformed = true
          break
        }

        index = closing + delimiter.length
        continue
      }

      const parameter = /^\$(\d+)/.exec(sql.slice(index))

      if (parameter) {
        const parameterIndex = Number(parameter[1])

        if (!Number.isSafeInteger(parameterIndex) || parameterIndex < 1) {
          malformed = true
          break
        }

        statement.executable = true
        pendingAdvisoryCall = false
        parameters.push({
          start: index,
          end: index + parameter[0].length,
          index: parameterIndex - 1,
        })
        index += parameter[0].length
        continue
      }
    }

    if (isWordStart(character)) {
      const start = index++
      while (index < sql.length && isWordPart(sql[index]!)) index++
      const word = sql.slice(start, index).toLowerCase()
      statement.executable = true
      statement.words.push(word)
      pendingAdvisoryCall = ADVISORY_FUNCTION_RE.test(word)
      continue
    }

    statement.executable = true
    if (character === '(' && pendingAdvisoryCall) statement.advisory = true
    pendingAdvisoryCall = false
    index++
  }

  finishStatement()

  const requiresCleanup =
    malformed ||
    statements.length === 0 ||
    statements.some((candidate) => {
      if (candidate.advisory) return true
      const [first, second] = candidate.words
      if (!first) return true
      if (TRANSACTION_STARTS.has(first)) return true
      if (first === 'start') return true
      if (first === 'prepare' && second === 'transaction') return true
      if (first === 'set' && second === 'transaction') return true
      return !PLAIN_STARTS.has(first)
    })

  return Object.freeze({
    requiresCleanup,
    malformed,
    parameters: Object.freeze(parameters),
  })
}
