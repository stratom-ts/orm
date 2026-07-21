import { postgresDialect } from '@/dialects'
import type { TableMetadata, TableOptions, TableSchema } from '@/schemas'
import {
  getColumnMetadata,
  getReferenceMetadata,
  getTableMetadata,
  normalizeIndex,
  table,
} from '@/schemas'
import type {
  ColumnRef,
  ColumnRefsOf,
  SchemaNameOf,
  TableHandle,
} from '@/types'
import { TABLE_HANDLE } from '@/types'
import type { AnySchema } from '@/types/schema'
import { assertNonEmptyString } from '@/utils/assertNonEmptyString'
import { SchemaError } from '@/utils/error'
import type { ObjectEntries } from 'valibot'
import { object, pipe, title } from 'valibot'

const IDENTITY_BASE_TYPES = new Set([
  'smallint',
  'integer',
  'bigint',
  'int2',
  'int4',
  'int8',
])

/** Handle methods that must not collide with column names. */
const RESERVED_HANDLE_KEYS = new Set(['getSchema', 'getTableMetadata'])

type ReferenceMetadata = ReturnType<typeof getReferenceMetadata>

/**
 * Asserts that the primary key names one or more declared columns.
 *
 * @throws SchemaError - When the key is empty or references an unknown column
 */
function validatePrimaryKey(
  metadata: TableMetadata,
  columnNames: string[],
): void {
  const primaryKeys = Array.isArray(metadata.primaryKey)
    ? metadata.primaryKey
    : [metadata.primaryKey]

  if (primaryKeys.length === 0) {
    throw new SchemaError({
      message:
        'primaryKey must be a column name or non-empty array of column names',
    })
  }

  for (const pk of primaryKeys) {
    assertNonEmptyString(pk, 'primaryKey column')
    if (!columnNames.includes(pk)) {
      throw new SchemaError({
        message: `primaryKey column "${pk}" is not defined on table "${metadata.name}"`,
      })
    }
  }
}

/**
 * Asserts every index has a valid name and references only declared columns.
 *
 * @throws SchemaError - When an index has no columns or references an unknown column
 */
function validateIndexes(metadata: TableMetadata, columnNames: string[]): void {
  if (!metadata.indexes) {
    return
  }

  for (const raw of metadata.indexes) {
    const index = normalizeIndex(raw)
    if (index.name !== undefined) {
      assertNonEmptyString(index.name, 'index name')
    }
    if (!index.columns || index.columns.length === 0) {
      throw new SchemaError({
        message: `index on table "${metadata.name}" must list at least one column`,
      })
    }
    for (const col of index.columns) {
      assertNonEmptyString(col, 'index column')
      if (!columnNames.includes(col)) {
        throw new SchemaError({
          message: `index column "${col}" is not defined on table "${metadata.name}"`,
        })
      }
    }
  }
}

/**
 * Asserts a foreign-key reference names both a target table and key.
 *
 * @throws SchemaError - When the reference is missing a target table or key
 */
function validateColumnReference(
  columnName: string,
  ref: ReferenceMetadata,
): void {
  if (!ref) {
    return
  }
  if (!ref.table) {
    throw new SchemaError({
      message: `reference on column "${columnName}" is missing a target table`,
    })
  }
  if (!ref.key) {
    throw new SchemaError({
      message: `reference on column "${columnName}" is missing a target key`,
    })
  }
}

/**
 * Asserts an identity/autoIncrement column resolves to a Postgres identity type.
 *
 * @throws SchemaError - When the resolved type is not smallint, integer, or bigint
 */
function validateIdentityColumn(
  tableName: string,
  columnName: string,
  colSchema: AnySchema,
  ref: ReferenceMetadata,
): void {
  const colMeta = getColumnMetadata(colSchema)
  if (colMeta?.generated === undefined && !colMeta?.autoIncrement) {
    return
  }

  const dataType = String(
    colMeta.type || ref?.dataType || postgresDialect.inferColumnType(colSchema),
  )
  const base = postgresDialect
    .normalizeDataType(dataType)
    .toLowerCase()
    .replace(/\(.*\)$/, '')
    .trim()
  if (!IDENTITY_BASE_TYPES.has(base)) {
    throw new SchemaError({
      message: `column "${columnName}" on table "${tableName}" uses identity/autoIncrement with type "${dataType}"; Postgres identity requires smallint, integer, or bigint`,
    })
  }
}

/**
 * Asserts every declared column's reference and identity type are valid.
 *
 * @throws SchemaError - When a reference or identity/autoIncrement type is invalid
 */
function validateColumns(schema: TableSchema, tableName: string): void {
  for (const [columnName, columnSchema] of Object.entries(schema.entries)) {
    const colSchema = columnSchema as AnySchema
    if (colSchema.kind !== 'schema') {
      continue
    }
    const ref = getReferenceMetadata(colSchema)
    validateColumnReference(columnName, ref)
    validateIdentityColumn(tableName, columnName, colSchema, ref)
  }
}

/**
 * Asserts that table metadata is internally consistent before a handle is built.
 *
 * Checks the table name/schema, the primary key, every index, and each column's
 * reference and identity/autoIncrement type against the declared columns.
 *
 * @param schema - Valibot object schema whose entries hold the column schemas
 * @param metadata - Resolved `table()` metadata (name, schema, primaryKey, indexes)
 * @param columnNames - Declared column names that primary keys and indexes must reference
 * @throws SchemaError - When any name, key, index, reference, or identity type is invalid
 */
function validateTableMetadata(
  schema: TableSchema,
  metadata: TableMetadata,
  columnNames: string[],
): void {
  assertNonEmptyString(metadata.name, 'table name')

  if (metadata.schema !== undefined) {
    assertNonEmptyString(metadata.schema, 'table schema')
  }

  validatePrimaryKey(metadata, columnNames)
  validateIndexes(metadata, columnNames)
  validateColumns(schema, metadata.name)
}

/**
 * Validates Valibot table metadata and returns a table handle with typed column refs.
 *
 * @param schema - Valibot object schema with `title()` and `table()` metadata
 * @returns Table handle for registration, queries, and column references
 * @throws SchemaError - When metadata is missing or invalid
 */
function buildTableHandle<S extends TableSchema>(schema: S): TableHandle<S> {
  const metadata = getTableMetadata(schema)
  if (!metadata) {
    throw new SchemaError({
      message:
        'defineTable requires table() metadata (name, primaryKey) on the schema',
    })
  }

  const entries = schema.entries as ObjectEntries
  const columnNames = Object.keys(entries).filter((key) => {
    const entry = entries[key] as AnySchema
    return entry && entry.kind === 'schema'
  })

  if (columnNames.length === 0) {
    throw new SchemaError({
      message: `table "${metadata.name}" must define at least one column`,
    })
  }

  for (const columnName of columnNames) {
    if (RESERVED_HANDLE_KEYS.has(columnName)) {
      throw new SchemaError({
        message: `column name "${columnName}" is reserved as a table handle method; rename the column`,
      })
    }
  }

  validateTableMetadata(schema, metadata, columnNames)

  const columns = {} as Record<string, ColumnRef>
  for (const columnName of columnNames) {
    columns[columnName] = {
      table: metadata.name,
      column: columnName,
      schema: metadata.schema,
      __type: undefined as never,
    }
  }

  // Column refs first; reserved handle methods win if a column reuses those names.
  const handle = {
    ...(columns as ColumnRefsOf<S>),
    [TABLE_HANDLE]: true as const,
    getSchema: () => schema,
    getTableMetadata: () => metadata as TableMetadata<SchemaNameOf<S>>,
  }

  return handle as TableHandle<S>
}

/**
 * Defines a table from a name, column map, and table options.
 *
 * Column values are Valibot schemas carrying `column()` / `reference()`
 * metadata. `primaryKey` and index `columns` are constrained to the declared
 * column names, so referencing an unknown column is a compile error.
 *
 * @param name - Database table name (also the logical name on column refs)
 * @param columns - Map of column name to Valibot column schema
 * @param options - Primary key, optional DB schema, and indexes
 * @returns Table handle for registration, queries, and column references
 * @throws SchemaError - When the resulting metadata is invalid
 *
 * @example
 * ```ts
 * const User = defineTable(
 *   'users',
 *   {
 *     id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
 *     email: pipe(string(), column({ type: 'varchar(255)', unique: true })),
 *   },
 *   {
 *     schema: 'public',
 *     primaryKey: 'id',
 *     indexes: [{ columns: ['email'], unique: true }],
 *   },
 * )
 * User.email // column ref
 * ```
 */
export function defineTable<
  const TName extends string,
  TCols extends ObjectEntries,
>(name: TName, columns: TCols, options: TableOptions<TCols>) {
  const schema = pipe(object(columns), title(name), table({ name, ...options }))
  return buildTableHandle(schema)
}

/**
 * Type guard for values produced by `defineTable`.
 */
export function isTableHandle(value: unknown): value is TableHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    TABLE_HANDLE in (value as object)
  )
}
