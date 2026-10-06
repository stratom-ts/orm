import { trimSqliteWhitespace } from './defaults'

/** Returns SQLite's stable affinity key for a declared type spelling. */
export function normalizeSqliteDataType(dataType: string): string {
  const type = dataType.trim().toUpperCase()

  if (type.includes('INT')) return 'integer'

  if (type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT'))
    return 'text'

  if (type.length === 0 || type.includes('BLOB')) return 'blob'

  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB'))
    return 'real'

  return 'numeric'
}

/** Removes balanced outer parentheses from a SQLite default expression. */
function stripEnclosingParens(expression: string): string {
  if (expression.length < 2 || expression[0] !== '(' || expression.at(-1) !== ')') {
    return expression
  }

  let quoted = false
  let depth = 0

  for (let index = 0; index < expression.length; index++) {
    const character = expression[index]!

    if (character === "'") {
      const escaped: boolean = quoted && expression[index + 1] === "'"
      index += escaped ? 1 : 0
      quoted = escaped ? quoted : !quoted

      continue
    }

    if (quoted) continue
    if (character === '(') depth++
    if (character === ')') depth--
    if (depth === 0 && index < expression.length - 1) return expression
  }

  return !quoted && depth === 0
    ? trimSqliteWhitespace(expression.slice(1, -1))
    : expression
}

/** Canonicalizes SQLite defaults for stable catalog comparison. */
export function normalizeSqliteDefaultExpression(expression: string): string {
  let result = trimSqliteWhitespace(expression)
  let previous: string

  do {
    previous = result
    result = stripEnclosingParens(result)
  } while (result !== previous)

  if (/^current_(timestamp|date|time)$/i.test(result)) return result.toLowerCase()

  if (/^(?:null|true|false)$/i.test(result)) {
    return result.toLowerCase() === 'null'
      ? 'null'
      : result.toLowerCase() === 'true'
        ? '1'
        : '0'
  }

  if (/^x'(?:[\da-f]{2})*'$/i.test(result)) return result.toLowerCase()

  return collapseUnquotedWhitespace(result)
}

/** Collapses spacing outside SQL string literals while preserving doubled quotes. */
function collapseUnquotedWhitespace(expression: string): string {
  let quoted = false
  let result = ''
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index]!

    if (character === "'" && quoted && expression[index + 1] === "'") {
      result += "''"
      index++
      continue
    }

    if (character === "'") quoted = !quoted

    result +=
      !quoted && /[ \t\r\n\f]/.test(character)
        ? result.endsWith(' ')
          ? ''
          : ' '
        : character
  }

  return result
}
