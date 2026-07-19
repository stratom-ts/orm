import { postgresDialect } from '@/dialects'
import type { AnySchema } from '@/types/schema'
import type {
  IndexConfig,
  TableIndex,
  TableMetadata,
  TableOptions,
  TableSchema,
} from '@/schemas'
import {
  getColumnMetadata,
  getReferenceMetadata,
  getTableMetadata,
  table,
} from '@/schemas'
import type {
  ColumnRef,
  ColumnRefsOf,
  SchemaNameOf,
  TableHandle,
} from '@/types'
import { TABLE_HANDLE } from '@/types'
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

/** Handle fields that must not collide with column names. */
const RESERVED_HANDLE_KEYS = new Set([
  'name',
  'schema',
  'metadata',
  'definition',
  'columns',
])

function normalizeIndex(index: TableIndex): IndexConfig {
  if (typeof index === 'string') {
    return { columns: [index] }
  }

  return index
}

function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SchemaError({ message: `${label} must be a non-empty string` })
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

  if (metadata.indexes) {
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

  for (const [columnName, columnSchema] of Object.entries(schema.entries)) {
    if ((columnSchema as AnySchema).kind !== 'schema') {
      continue
    }
    const colSchema = columnSchema as AnySchema
    const ref = getReferenceMetadata(colSchema)
    if (ref) {
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
    const colMeta = getColumnMetadata(colSchema)
    if (colMeta?.generated !== undefined || colMeta?.autoIncrement) {
      const dataType = String(
        colMeta.type ||
          ref?.dataType ||
          postgresDialect.inferColumnType(colSchema),
      )
      const base = postgresDialect
        .normalizeDataType(dataType)
        .toLowerCase()
        .replace(/\(.*\)$/, '')
        .trim()
      if (!IDENTITY_BASE_TYPES.has(base)) {
        throw new SchemaError({
          message: `column "${columnName}" on table "${metadata.name}" uses identity/autoIncrement with type "${dataType}"; Postgres identity requires smallint, integer, or bigint`,
        })
      }
    }
  }
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
        message: `column name "${columnName}" is reserved on table handles; rename the column`,
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

  // Column refs first; reserved handle fields win if a column reuses those names.
  const handle = {
    ...(columns as ColumnRefsOf<S>),
    [TABLE_HANDLE]: true as const,
    definition: schema,
    name: metadata.name as SchemaNameOf<S>,
    schema: metadata.schema,
    metadata: metadata as TableMetadata<SchemaNameOf<S>>,
    columns: columns as ColumnRefsOf<S>,
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
