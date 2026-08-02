import type { CreateTableAst, LoweredDesiredTable } from '@/dialects/types'
import type { ReferentialAction } from '@/schemas/actions/types'

export type ColumnReferenceAst = {
  readonly table: string
  readonly column: string
  readonly schema?: string
  readonly onDelete?: ReferentialAction
  readonly onUpdate?: ReferentialAction
}

export type ColumnDefAst = CreateTableAst['columns'][number]

export type { CreateTableAst }

/**
 * Returns the create-table AST produced by whole-graph selected-dialect lowering.
 *
 * @example
 *   const ast = buildCreateTableAst(loweredTable)
 *   // { kind: 'create_table', table: 'users', columns: [...], primaryKey: ['id'] }
 *
 * @param table - Physically resolved desired table.
 *
 * @returns Create-table AST node
 */
export function buildCreateTableAst(table: LoweredDesiredTable): CreateTableAst {
  return table.ast
}
