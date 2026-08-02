import { describe, expectTypeOf, it } from 'vitest'

import type { LoweredDatabaseDefault, MigrationPlan, MigrationStep } from '@/index'

type ExpectedMigrationStep =
  | { kind: 'create_schema'; schema: string }
  | { kind: 'create_table'; schema?: string; table: string }
  | {
      kind: 'add_column'
      schema?: string
      table: string
      column: string
      dataType: string
      notNull: boolean
      unique?: boolean
      defaultValue?: string | number | boolean | null
      databaseDefault?: LoweredDatabaseDefault
      generated?: 'always' | 'byDefault'
      autoIncrement?: boolean
      references?: {
        table: string
        column: string
        schema?: string
        onDelete?: string
        onUpdate?: string
      }
    }
  | {
      kind: 'alter_column_type'
      schema?: string
      table: string
      column: string
      dataType: string
    }
  | {
      kind: 'add_foreign_key'
      schema?: string
      table: string
      column: string
      references: {
        table: string
        column: string
        schema?: string
        onDelete?: string
        onUpdate?: string
      }
    }
  | {
      kind: 'add_unique_constraint'
      schema?: string
      table: string
      column: string
    }
  | { kind: 'set_not_null'; schema?: string; table: string; column: string }
  | { kind: 'drop_not_null'; schema?: string; table: string; column: string }
  | {
      kind: 'create_index'
      schema?: string
      table: string
      index: string
      columns: string[]
      unique: boolean
    }
  | { kind: 'drop_column'; schema?: string; table: string; column: string }
  | { kind: 'drop_table'; schema?: string; table: string }
  | { kind: 'drop_index'; schema?: string; table: string; index: string }

describe('public Migration Plan types', () => {
  it('keeps the descriptive plan and step shapes exact', () => {
    expectTypeOf<MigrationPlan>().toEqualTypeOf<{ steps: MigrationStep[] }>()
    expectTypeOf<MigrationStep>().toEqualTypeOf<ExpectedMigrationStep>()
    expectTypeOf<Extract<MigrationStep, { kind: 'create_table' }>>().toEqualTypeOf<{
      kind: 'create_table'
      schema?: string
      table: string
    }>()
  })
})
