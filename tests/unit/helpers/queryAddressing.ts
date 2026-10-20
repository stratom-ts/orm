import type { Dialect, SqlAst } from '@/dialects'

/**
 * Returns exact authored relation/member matching for lightweight test dialects.
 *
 * @param compile - Compiler supplied by the owning test dialect.
 */
export function exactQueryAddressing(
  compile: (
    node: SqlAst,
  ) => ReturnType<ReturnType<Dialect['query']['resolve']>['compile']>,
): Dialect['query'] {
  return {
    /** Binds query compilation and matching to the registered table handles. */
    resolve(registered) {
      return {
        compile,
        /** Finds handles matching the authored relation under query rules. */
        findRelationMatches(relation, handles = registered) {
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
        /** Finds column names equal under the selected query rules. */
        findColumnMatches(handle, column) {
          return Object.keys(handle.getSchema().entries).filter(
            (candidate) => candidate === column,
          )
        },
      }
    },
  }
}
