import type { CompiledQuery as DialectCompiledQuery } from '@/dialects'
import { QueryError } from '@/utils/error'

declare const compiledQuery: unique symbol

/** SQL produced by a builder or the scoped SQL helpers. */
export type CompiledQuery = Readonly<DialectCompiledQuery> & {
  readonly [compiledQuery]: true
}

const queries = new WeakSet()

/** Marks an immutable snapshot so SQL cannot be replaced after compilation. */
export function markCompiledQuery(query: DialectCompiledQuery): CompiledQuery {
  const snapshot = Object.freeze({
    ...query,
    params: Object.freeze([...query.params]),
    ...(query.resultProjection
      ? {
          resultProjection: Object.freeze(
            query.resultProjection.map((item) => Object.freeze({ ...item })),
          ),
        }
      : {}),
  })

  queries.add(snapshot)
  return snapshot as CompiledQuery
}

/** Rejects plain objects and copied markers from JavaScript callers. */
export function assertCompiledQuery(query: unknown): asserts query is CompiledQuery {
  if (typeof query !== 'object' || query === null || !queries.has(query)) {
    throw new QueryError({
      message: 'execute requires builder compile() output or sql.fragment/unsafe output',
    })
  }
}

/** Restores application output names independently of optional value mapping. */
export function restoreResultNames(
  query: DialectCompiledQuery,
  rows: unknown[],
): unknown[] {
  if (!query.resultProjection) return rows

  const names = new Map(
    query.resultProjection.map(({ sqlName, outputName }) => [sqlName, outputName]),
  )

  return rows.map((row) =>
    row && typeof row === 'object' && !Array.isArray(row)
      ? Object.fromEntries(
          Object.entries(row).map(([key, value]) => [names.get(key) ?? key, value]),
        )
      : row,
  )
}
