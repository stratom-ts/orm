import { InvariantError } from '@/utils/error'

/** Validates a safe SQLite declared type while retaining its authored spelling. */
export function assertSafeSqliteDataType(dataType: string): string {
  const value = dataType.trim()
  if (!value) throw new InvariantError('column data type must be a non-empty string')
  if (/[;"'\\]|--|\/\*|\*\//.test(value)) {
    throw new InvariantError(`unsafe column data type: ${JSON.stringify(dataType)}`)
  }
  const match = value.match(
    /^([A-Za-z][A-Za-z0-9_ ]*)(?:\s*\(\s*([0-9]+(?:\s*,\s*[0-9]+)?)\s*\))?$/,
  )
  const reserved =
    /\b(primary|key|not|null|unique|references|check|default|collate|constraint|generated|as)\b/i
  if (!match || reserved.test(match[1]!)) {
    throw new InvariantError(`unsupported column data type: ${JSON.stringify(dataType)}`)
  }
  return value
}

export function formatSqliteLiteral(value: string | number | boolean | null): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new InvariantError('column default number must be finite')
    return String(value)
  }
  return `'${value.replaceAll("'", "''")}'`
}

export function formatSqliteDefault(value: string | number | boolean | null): string {
  return formatSqliteLiteral(value)
}

/** Canonicalizes SQLite defaults without changing quoted literal contents. */
export function normalizeSqliteDefaultExpression(expression: string): string {
  const source = expression.trim()
  let result = ''
  let quoted = false
  let pendingSpace = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (c === "'") {
      if (pendingSpace && result) result += ' '
      pendingSpace = false
      result += c
      if (quoted && source[i + 1] === "'") result += source[++i]!
      else quoted = !quoted
      continue
    }
    if (quoted) {
      result += c
      continue
    }
    if (/\s/.test(c)) {
      pendingSpace = result.length > 0
      continue
    }
    if (pendingSpace && result) result += ' '
    pendingSpace = false
    const code = c.charCodeAt(0)
    result += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : c
  }
  return result.trim()
}

/** A conservative expression check for dialect-tagged SQLite defaults. */
export function assertSafeSqliteExpression(expression: string): string {
  const value = expression.trim()
  if (!value || /[;]|--|\/\*|\*\/|\$/.test(value)) {
    throw new InvariantError(
      `Unsafe SQLite database expression ${JSON.stringify(expression)}`,
    )
  }
  let quoted = false
  let depth = 0
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === "'") {
      if (quoted && value[i + 1] === "'") i++
      else quoted = !quoted
    } else if (!quoted && c === '(') depth++
    else if (!quoted && c === ')' && --depth < 0)
      throw new InvariantError(
        `Unsafe SQLite database expression ${JSON.stringify(expression)}`,
      )
  }
  if (quoted || depth !== 0)
    throw new InvariantError(
      `Unsafe SQLite database expression ${JSON.stringify(expression)}`,
    )
  return value
}
