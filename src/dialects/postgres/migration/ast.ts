type PostgresCreateTableColumnAst = {
  readonly name: string
  readonly dataType: string
  readonly notNull: boolean
  readonly unique: boolean
  readonly uniqueConstraintName?: string
  readonly autoIncrement: boolean
  readonly databaseDefault?: Readonly<{ sql: string; normalized: string }>
  readonly generated?: 'always' | 'byDefault'
  readonly references?: Readonly<{
    readonly table: string
    readonly schema: string
    readonly column: string
    readonly onDelete?: string
    readonly onUpdate?: string
  }>
}

type PostgresCreateTableAst = {
  readonly kind: 'create_table'
  readonly table: string
  readonly schema: string
  readonly columns: readonly PostgresCreateTableColumnAst[]
  readonly primaryKey: readonly string[]
  readonly primaryKeyName?: string
}

type PostgresRelationAst = { readonly table: string; readonly schema: string }

type PostgresDdlAst =
  | (PostgresRelationAst & {
      readonly kind: 'rename_column'
      readonly from: string
      readonly column: string
    })
  | (PostgresRelationAst & {
      readonly kind: 'create_index'
      readonly concurrently?: boolean
      readonly name: string
      readonly columns: readonly string[]
      readonly unique: boolean
    })
  | (PostgresRelationAst & {
      readonly kind: 'add_column'
      readonly column: PostgresCreateTableColumnAst
    })
  | (PostgresRelationAst & {
      readonly kind: 'add_foreign_key'
      readonly column: string
      readonly name?: string
      readonly references: PostgresRelationAst & {
        readonly column: string
        readonly onDelete?: string
        readonly onUpdate?: string
      }
    })
  | (PostgresRelationAst & {
      readonly kind: 'add_unique_constraint'
      readonly column: string
      readonly name: string
    })
  | (PostgresRelationAst & {
      readonly kind: 'alter_column_type'
      readonly column: string
      readonly dataType: string
    })
  | (PostgresRelationAst & {
      readonly kind: 'set_not_null' | 'drop_not_null' | 'drop_column'
      readonly column: string
    })
  | (PostgresRelationAst & { readonly kind: 'drop_table' })
  | (PostgresRelationAst & {
      readonly kind: 'drop_index'
      readonly index: string
      readonly concurrently?: boolean
    })
  | { readonly kind: 'create_schema'; readonly schema: string }
  | PostgresCreateTableAst

export type { PostgresCreateTableColumnAst, PostgresCreateTableAst, PostgresDdlAst }
