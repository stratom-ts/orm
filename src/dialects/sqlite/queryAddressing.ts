import type { RelationIdentityInput } from '@/schemas'
import type { TableHandle } from '@/types'
import { QueryError } from '@/utils/error'

import type { DialectQueryResolution, DialectQueryResolveOptions } from '../types'

import { compileSqliteQuery, createSqliteQueryRelationResolver } from './compile'
import { asciiFoldSqliteIdentifier } from './identity'
import { projectSqliteQuery } from './queryProjection'

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
      return compileSqliteQuery(projectSqliteQuery(query, node), resolveRelation)
    },
    /** Finds handles matching the authored relation under query rules. */
    findRelationMatches(
      relation: RelationIdentityInput,
      candidates?: readonly TableHandle[],
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
    },
    /** Finds column names equal under the selected query rules. */
    findColumnMatches(handle: TableHandle, column: string): readonly string[] {
      if (typeof column !== 'string' || column.length === 0) {
        throw new QueryError({
          message: 'SQLite query column must be a non-empty string',
        })
      }

      const key = asciiFoldSqliteIdentifier(column)
      return Object.keys(handle.getSchema().entries).filter(
        (candidate) => asciiFoldSqliteIdentifier(candidate) === key,
      )
    },
  })

  return query
}
