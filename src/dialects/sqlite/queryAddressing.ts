import type { RelationIdentityInput } from '@/schemas'
import type { TableHandle } from '@/types'
import { QueryError } from '@/utils/error'

import type { DialectQueryResolution, DialectQueryResolveOptions } from '../types'

import { compileSqliteQuery, createSqliteQueryRelationResolver } from './compile'

type ResolvedRelation = ReturnType<ReturnType<typeof createSqliteQueryRelationResolver>>
type RegisteredRelation = Readonly<{ handle: TableHandle; relation: ResolvedRelation }>

/** Finds handles matching the authored relation under SQLite query rules. */
function findSqliteQueryRelationMatches(
  relation: RelationIdentityInput,
  candidates: readonly TableHandle[] | undefined,
  registered: readonly RegisteredRelation[],
  resolveRelation: ReturnType<typeof createSqliteQueryRelationResolver>,
): readonly TableHandle[] {
  const expected = resolveRelation(relation)
  const available = candidates
    ? candidates.map((handle) => ({
        handle,
        relation: resolveRelation(handle.getTableMetadata().relation),
      }))
    : registered

  return available
    .filter((candidate) => candidate.relation.tableKey === expected.tableKey)
    .map((candidate) => candidate.handle)
}

/** Finds column names equal under SQLite query rules. */
function findSqliteQueryColumnMatches(
  handle: TableHandle,
  column: string,
): readonly string[] {
  if (typeof column !== 'string')
    throw new QueryError({ message: 'SQLite application column must be a string' })

  return Object.keys(handle.getSchema().entries).filter(
    (candidate) => candidate === column,
  )
}

/** Resolves one client registry under SQLite's database:main profile. */
export function resolveSqliteQuery(
  handles: readonly TableHandle[],
  options?: DialectQueryResolveOptions,
): DialectQueryResolution {
  const resolveRelation = createSqliteQueryRelationResolver(options?.registrationDefault)
  const registered = handles.map((handle) => ({
    handle,
    relation: resolveRelation(handle.getTableMetadata().relation),
  }))

  const query: DialectQueryResolution = Object.freeze({
    /** Compiles the current query or command into SQL and ordered bound parameters. */
    compile(node: Parameters<typeof compileSqliteQuery>[0]) {
      return compileSqliteQuery(node, resolveRelation)
    },
    findRelationMatches(
      relation: RelationIdentityInput,
      candidates?: readonly TableHandle[],
    ) {
      return findSqliteQueryRelationMatches(
        relation,
        candidates,
        registered,
        resolveRelation,
      )
    },
    findColumnMatches: findSqliteQueryColumnMatches,
  })

  return query
}
