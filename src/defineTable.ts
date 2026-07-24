import { postgresDialect } from '@/dialects'
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
import { SchemaError } from '@/utils/error'
import type { BaseIssue, BaseSchema, InferOutput, ObjectEntries } from 'valibot'
import { object, pipe, title } from 'valibot'

const IDENTITY_BASE_TYPES = new Set([
  'smallint',
  'integer',
  'bigint',
  'int2',
  'int4',
  'int8',
])

/** Runtime brand for table handles returned by `defineTable`. */
export const TABLE_HANDLE = Symbol.for('stratom.TableHandle')

/**
 * Stable typed reference to a table column (for where/select/join/orderBy).
 */
export type ColumnRef<
  TTable extends string = string,
  TColumn extends string = string,
  TType = unknown,
  TSchema extends string | undefined = string | undefined,
> = {
  readonly table: TTable
  readonly column: TColumn
  readonly schema: TSchema
  readonly __type: TType
}

type ColumnEntries<S extends TableSchema> = S['entries']

type SchemaNameOf<S extends TableSchema> =
  S extends TableSchema<infer N> ? N : string

type ColumnRefsOf<S extends TableSchema> = {
  readonly [K in keyof ColumnEntries<S> & string]: ColumnRef<
    SchemaNameOf<S>,
    K,
    InferOutput<ColumnEntries<S>[K]>,
    string | undefined
  >
}

/**
 * Table handle produced by `defineTable` — the unit accepted by `createDb` / `db.from`.
 */
export type TableHandle<S extends TableSchema = TableSchema> = {
  readonly [TABLE_HANDLE]: true
  /** Valibot table schema (source of validation + column metadata). */
  readonly definition: S
  /** Database table name from `table({ name })`. */
  readonly name: SchemaNameOf<S>
  /** Postgres schema namespace from `table({ schema })`, if any. */
  readonly schema: string | undefined
  /** Full table metadata. */
  readonly metadata: TableMetadata<SchemaNameOf<S>>
  /** Column refs keyed by property name. */
  readonly columns: ColumnRefsOf<S>
} & ColumnRefsOf<S>
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
    if (
      (columnSchema as BaseSchema<unknown, unknown, BaseIssue<unknown>>)
        .kind !== 'schema'
    ) {
      continue
    }
    const colSchema = columnSchema as BaseSchema<
      unknown,
      unknown,
      BaseIssue<unknown>
    >
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
    const entry = entries[key] as BaseSchema<
      unknown,
      unknown,
      BaseIssue<unknown>
    >
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
