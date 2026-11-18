export type ColumnNamingContext = Readonly<{
  column: string
  table: string
}>

export type ColumnNamingFunction = (context: ColumnNamingContext) => string

/** Converts ASCII word boundaries to underscores without changing other characters. */
export const snakeCase: ColumnNamingFunction = ({ column }) => {
  let result = ''
  for (let i = 0; i < column.length; i++) {
    const previous = column[i - 1] ?? ''
    const current = column[i]
    const next = column[i + 1] ?? ''
    const upper = (value: string) => /^[A-Z]$/.test(value)
    const lower = (value: string) => /^[a-z]$/.test(value)
    const digit = (value: string) => /^[0-9]$/.test(value)

    if (
      i > 0 &&
      previous !== '_' &&
      current !== '_' &&
      ((upper(current) && !upper(previous)) ||
        (upper(previous) && upper(current) && lower(next)) ||
        (digit(current) && !digit(previous)) ||
        (digit(previous) && (upper(current) || lower(current))))
    )
      result += '_'

    result += upper(current) ? String.fromCharCode(current.charCodeAt(0) + 32) : current
  }

  return result
}
