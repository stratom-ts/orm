import { QueryError } from '@/utils/error'

import type { CompiledQuery, OrderByAst, SelectAst } from './types'

/** Quotes only validated selected output aliases, never source expressions. */
function compoundOrder(term: OrderByAst): string {
  if (!['asc', 'desc'].includes(term.direction))
    throw new QueryError({ message: 'orderBy direction must be asc or desc' })

  if (term.nulls !== undefined && !['first', 'last'].includes(term.nulls))
    throw new QueryError({ message: 'orderBy nulls must be first or last' })

  const name = `"${term.column.replaceAll('"', '""')}"`
  return `${name} ${term.direction}${term.nulls === undefined ? '' : ` nulls ${term.nulls}`}`
}

/** Uses derived SELECT operands to preserve portable grouping and branch clauses. */
export function compileCompoundSelect(
  node: SelectAst,
  compile: (operand: SelectAst) => string,
  params: unknown[],
  dialect: 'postgresql' | 'sqlite',
): CompiledQuery {
  const compound = node.compound!
  const left = compile(compound.left)
  const right = compile(compound.right)
  let sql = `select * from (${left}) as "__stratom_set_l" ${compound.operator} select * from (${right}) as "__stratom_set_r"`

  if (node.orderBy?.length)
    sql += ` order by ${node.orderBy.map(compoundOrder).join(', ')}`

  for (const clause of ['limit', 'offset'] as const) {
    const count = node[clause]

    if (count === undefined) continue

    if (
      !(dialect === 'sqlite' ? Number.isSafeInteger(count) : Number.isInteger(count)) ||
      count < 0
    )
      throw new QueryError({
        message: `${clause} must be a non-negative ${dialect === 'sqlite' ? 'safe integer' : 'integer'}`,
      })

    if (dialect === 'sqlite' && clause === 'offset' && node.limit === undefined)
      sql += ' limit -1'

    params.push(count)
    sql += ` ${clause} ${dialect === 'sqlite' ? '?' : `$${params.length}`}`
  }

  return { sql, params }
}
