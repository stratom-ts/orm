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
  const snapshot = Object.freeze({ ...query, params: Object.freeze([...query.params]) })
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
