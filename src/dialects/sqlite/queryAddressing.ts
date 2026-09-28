import type { RelationIdentityInput } from '@/schemas'
import type { TableHandle } from '@/types'
import { QueryError } from '@/utils/error'

import type { DialectQueryResolveOptions } from '../types'

import { compileSqlite, createSqliteQueryRelationResolver } from './compile'
import { asciiFoldSqliteIdentifier } from './identity'

/** Resolves one client registry under SQLite's database:main profile. */
export function resolveSqliteQuery(
  handles: readonly TableHandle[],
  options?: DialectQueryResolveOptions,
) {
  const resolveRelation = createSqliteQueryRelationResolver(options?.registrationDefault)
  const registered = handles.map((handle) => ({
    handle,
    relation: resolveRelation(handle.getTableMetadata().relation),
  }))

  return Object.freeze({
    compile(node: Parameters<typeof compileSqlite>[0]) {
      return compileSqlite(node, resolveRelation)
    },
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
}
