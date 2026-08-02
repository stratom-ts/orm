import type { CreateTableAst } from '@/dialects/types'
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
