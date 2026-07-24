import type { CreateTableAst, Dialect } from '@/dialects'
import type { TableHandle } from '@/types'
import {
  getColumnMetadata,
  getReferenceMetadata,
  isSqlNullable,
} from '@/schemas'
import type { ReferentialAction } from '@/schemas'
import { MigrationError, SchemaError } from '@/utils/error'

export type ColumnReferenceAst = {
  readonly table: string
  readonly column: string
  readonly schema?: string
  readonly onDelete?: ReferentialAction
  readonly onUpdate?: ReferentialAction
}

export type ColumnDefAst = CreateTableAst['columns'][number]

export type { CreateTableAst }

const IDENTITY_BASE_TYPES = new Set([
  'smallint',
  'integer',
  'bigint',
  'int2',
  'int4',
  'int8',
])

function isIdentityCompatibleType(dataType: string, dialect: Dialect): boolean {
  const normalized = dialect.normalizeDataType(dataType).toLowerCase()
  const base = normalized.replace(/\(.*\)$/, '').trim()
  return IDENTITY_BASE_TYPES.has(base)
}

/**
 * Builds a create-table AST from a table handle and dialect type inference.
 */
export function buildCreateTableAst(
  handle: TableHandle,
  dialect: Dialect,
): CreateTableAst {
  const metadata = handle.metadata
  const primaryKey = Array.isArray(metadata.primaryKey)
    ? [...metadata.primaryKey]
    : [metadata.primaryKey]

  if (primaryKey.length === 0 || primaryKey.some((k) => !k)) {
    throw new MigrationError({
      message: `table "${metadata.name}" must declare a primary key`,
    })
  }

  const columns: ColumnDefAst[] = []

  for (const [columnName, columnSchema] of Object.entries(
    handle.definition.entries,
  )) {
    if (!columnSchema || columnSchema.kind !== 'schema') continue

    const columnMetadata = getColumnMetadata(columnSchema)
    const referenceMetadata = getReferenceMetadata(columnSchema)

    const dataType = String(
      columnMetadata?.type ||
        referenceMetadata?.dataType ||
        dialect.inferColumnType(columnSchema),
    )

    const sqlNullable = isSqlNullable(columnSchema)
    const unique = columnMetadata?.unique ?? false
    const autoIncrement = columnMetadata?.autoIncrement ?? false
    const generated = columnMetadata?.generated

    if (
      (generated !== undefined || autoIncrement) &&
      !isIdentityCompatibleType(dataType, dialect)
    ) {
      throw new SchemaError({
        message: `column "${columnName}" on table "${metadata.name}" uses identity/autoIncrement with type "${dataType}"; Postgres identity requires smallint, integer, or bigint`,
      })
    }

    let references: ColumnReferenceAst | undefined
    if (referenceMetadata?.table && referenceMetadata.key) {
      references = {
        table: referenceMetadata.table,
        column: referenceMetadata.key,
        ...(referenceMetadata.schema !== undefined
          ? { schema: referenceMetadata.schema }
          : {}),
        ...(referenceMetadata.onDelete
          ? { onDelete: referenceMetadata.onDelete }
          : {}),
        ...(referenceMetadata.onUpdate
          ? { onUpdate: referenceMetadata.onUpdate }
          : {}),
      }
    }

    columns.push({
      name: columnName,
      dataType,
      notNull: !sqlNullable,
      unique: unique && !primaryKey.includes(columnName),
      autoIncrement,
      ...(columnMetadata?.default !== undefined
        ? { defaultValue: columnMetadata.default }
        : {}),
      ...(generated ? { generated } : {}),
      ...(references ? { references } : {}),
    })
  }

  if (columns.length === 0) {
    throw new MigrationError({
      message: `table "${metadata.name}" has no columns`,
    })
  }

  const ast: CreateTableAst = {
    kind: 'create_table',
    table: metadata.name,
    ...(metadata.schema !== undefined ? { schema: metadata.schema } : {}),
    columns,
    primaryKey,
  }
  return ast
}
