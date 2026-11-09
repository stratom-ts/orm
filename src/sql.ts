import type { DialectQuery } from '@/dialects'
import type { CompiledQuery } from '@/query/compiled'
import { markCompiledQuery } from '@/query/compiled'
import { QueryError } from '@/utils/error'

/** Parameterized fragment accepted by the SQL tag and execute(). */
type SqlFragment = CompiledQuery

/** Scoped SQL execution. Values bind; identifiers require id(). */
type SqlTag = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>
  fragment(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment
  id(...parts: string[]): SqlFragment
  unsafe(text: string): SqlFragment
}

type Part = string | { value: unknown } | { identifier: string }
const fragments = new WeakMap<object, readonly Part[]>()

/** Compiles fragment parts with the selected dialect syntax. */
function compileFragment(
  syntax: DialectQuery['rawSql'],
  parts: readonly Part[],
): SqlFragment {
  if (!syntax)
    throw new QueryError({ message: 'This dialect does not support SQL templates' })

  const params: unknown[] = []

  const sql = parts
    .map((part) => {
      if (typeof part === 'string') return part
      if ('identifier' in part) return syntax.quoteIdentifier(part.identifier)

      params.push(part.value)
      return syntax.placeholder(params.length)
    })
    .join('')

  const result = markCompiledQuery({ sql, params })
  fragments.set(result, parts)
  return result
}

/** Validates the JavaScript call shape before reading template text. */
function assertTemplate(
  value: unknown,
  count: number,
): asserts value is TemplateStringsArray {
  if (
    !Array.isArray(value) ||
    !Object.hasOwn(value, 'raw') ||
    value.length !== count + 1 ||
    value.some((part) => typeof part !== 'string')
  )
    throw new QueryError({ message: 'Use sql as a tagged template' })
}

/** Creates an eager tag using the same executor as the surrounding client scope. */
function createSqlTag(
  syntax: DialectQuery['rawSql'],
  execute: (query: CompiledQuery) => Promise<unknown[]>,
): SqlTag {
  const fragment = (strings: TemplateStringsArray, ...values: unknown[]): SqlFragment => {
    assertTemplate(strings, values.length)

    const parts: Part[] = [strings[0]]
    for (const [index, value] of values.entries()) {
      const nested =
        typeof value === 'object' && value !== null ? fragments.get(value) : undefined

      parts.push(...(nested ?? [{ value }]), strings[index + 1])
    }

    return compileFragment(syntax, parts)
  }

  const sql: SqlTag = async (strings, ...values) => execute(fragment(strings, ...values))
  sql.fragment = fragment

  sql.id = (...parts) => {
    if (
      parts.length === 0 ||
      parts.some((part) => typeof part !== 'string' || !part || part.includes('\0'))
    ) {
      throw new QueryError({
        message: 'SQL identifiers require non-empty parts without NUL characters',
      })
    }

    return compileFragment(
      syntax,
      parts.flatMap((identifier, index) =>
        index === 0 ? [{ identifier }] : ['.', { identifier }],
      ),
    )
  }

  sql.unsafe = (text) => {
    if (typeof text !== 'string')
      throw new QueryError({ message: 'sql.unsafe requires SQL text' })

    return compileFragment(syntax, [text])
  }

  return sql
}

export type { SqlFragment, SqlTag }

export { createSqlTag }
