import type { ColumnDataType } from 'kysely'
import type { BaseIssue, BaseSchema } from 'valibot'

export interface DialectAdapter {
  inferColumnType(
    schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
  ): ColumnDataType

  normalizeDataType(dataType: string): string
}
