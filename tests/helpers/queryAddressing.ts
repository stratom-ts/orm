import type { Dialect } from '@/dialects'

/**
 * Returns exact authored relation/member matching for lightweight test dialects.
 *
 * @example
 *   const dialect = { ...postgresDialect, query: { ...postgresDialect.query, ...exactQueryAddressing() } }
 */
export function exactQueryAddressing(): Pick<
  Dialect['query'],
  'findRelationMatches' | 'findColumnMatches'
> {
  return {
    findRelationMatches(handles, relation) {
      return handles.filter((handle) => {
        const candidate = handle.getTableMetadata().relation
        const left = candidate.namespace ?? []
        const right = relation.namespace ?? []

        return (
          candidate.relation === relation.relation &&
          left.length === right.length &&
          left.every(
            (segment, index) =>
              segment.role === right[index]?.role &&
              segment.spelling === right[index]?.spelling,
          )
        )
      })
    },
    findColumnMatches(handle, column) {
      return Object.keys(handle.getSchema().entries).filter(
        (candidate) => candidate === column,
      )
    },
  }
}
