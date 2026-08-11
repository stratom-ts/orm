import type { ObjectEntries } from 'valibot'
import { object, pipe, title } from 'valibot'

import type { ColumnMetadata, TableMetadata, TableOptions, TableSchema } from '@/schemas'
import {
  getColumnMetadata,
  getReferenceMetadata,
  getTableMetadata,
  isSqlNullable,
  table,
} from '@/schemas'
import type { ColumnRef, ColumnRefsOf, SchemaNameOf, TableHandle } from '@/types'
import { TABLE_HANDLE } from '@/types'
import type { AnySchema } from '@/types/schema'
import { assertNonEmptyString } from '@/utils/assertNonEmptyString'
import { SchemaError } from '@/utils/error'

/** Handle methods that must not collide with column names. */
const RESERVED_HANDLE_KEYS = new Set(['getSchema', 'getTableMetadata'])

type ReferenceMetadata = ReturnType<typeof getReferenceMetadata>

/**
 * Asserts that the primary key names one or more declared columns.
 *
 * @example
 *   validatePrimaryKey(schema, { name: 'users', primaryKey: 'id' }, ['id', 'name'])
 *
 * @param schema - Table schema containing the declared columns.
 * @param metadata - Table metadata containing the primary key definition.
 * @param columnNames - Declared column names on the table.
 *
 * @throws SchemaError - When the key is empty or references an unknown column
 */
function validatePrimaryKey(
  schema: TableSchema,
  metadata: TableMetadata,
  columnNames: string[],
): void {
  const primaryKeys = Array.isArray(metadata.primaryKey)
    ? metadata.primaryKey
    : [metadata.primaryKey]

  if (primaryKeys.length === 0) {
    throw new SchemaError({
      message: 'primaryKey must be a column name or non-empty array of column names',
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
  if (new Set(primaryKeys).size !== primaryKeys.length) {
    throw new SchemaError({
      message: `primaryKey on table "${metadata.name}" contains duplicate columns`,
    })
  }
  for (const pk of primaryKeys) {
    if (isSqlNullable(schema.entries[pk] as AnySchema)) {
      throw new SchemaError({
        message: `primaryKey column "${pk}" on table "${metadata.name}" cannot be nullable`,
      })
    }
  }
}

/**
 * Asserts every index has a valid name and references only declared columns.
 *
 * @example
 *   validateIndexes({ name: 'users', indexes: [{ columns: ['email'] }] }, ['id', 'email'])
 *
 * @param metadata - Table metadata containing index definitions.
 * @param columnNames - Declared column names on the table.
 *
 * @throws SchemaError - When an index has no columns or references an unknown column
 */
function validateIndexes(metadata: TableMetadata, columnNames: string[]): void {
  if (!metadata.indexes) {
    return
  }

  const names = new Set<string>()
  const definitions = new Set<string>()
  for (const raw of metadata.indexes) {
    const index = raw
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
    if (new Set(index.columns).size !== index.columns.length) {
      throw new SchemaError({
        message: `index on table "${metadata.name}" contains duplicate columns`,
      })
    }
    const definition = JSON.stringify([index.columns, index.unique ?? false])
    if (definitions.has(definition)) {
      throw new SchemaError({
        message: `duplicate index definition on table "${metadata.name}"`,
      })
    }
    definitions.add(definition)
    if (index.name === undefined) continue
    if (names.has(index.name)) {
      throw new SchemaError({
        message: `duplicate explicit index name "${index.name}" on table "${metadata.name}"`,
      })
    }
    names.add(index.name)
  }
}

/**
 * Asserts dialect-independent column option combinations are valid.
 *
 * @example
 *   validateColumnOptions('users', 'name', stringSchema)
 *
 * @param tableName - Table name for error context.
 * @param columnName - Column name for error context.
 * @param colSchema - Column schema to validate.
 *
 * @throws SchemaError - When contradictory column options are set
 */
function validateColumnOptions(
  tableName: string,
  columnName: string,
  colSchema: AnySchema,
): void {
  const metadata = getColumnMetadata(colSchema)
  if (!metadata) return
  const hasDefault = metadata.databaseDefault !== undefined
  const hasGeneration = metadata.generation !== undefined
  if (hasDefault && hasGeneration) {
    throw new SchemaError({
      message: `column "${columnName}" on table "${tableName}" cannot combine a default with identity generation`,
    })
  }
  if (
    !isSqlNullable(colSchema) &&
    metadata.databaseDefault?.kind === 'literal' &&
    metadata.databaseDefault.value === null
  ) {
    throw new SchemaError({
      message: `NOT NULL column "${columnName}" on table "${tableName}" cannot have a null database default`,
    })
  }
}

/**
 * Asserts a foreign-key reference names both a target table and key.
 *
 * @example
 *   validateColumnReference('authorId', { table: 'users', key: 'id' })
 *
 * @param columnName - Column name for error context.
 * @param ref - Reference metadata to validate.
 *
 * @throws SchemaError - When the reference is missing a target table or key
 */
function validateColumnReference(columnName: string, ref: ReferenceMetadata): void {
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
 * Checks whether a column has a database, generated, or schema default value source.
 *
 * @example
 *   hasValueSource(
 *     { kind: 'column', databaseDefault: { kind: 'literal', value: 0 } },
 *     undefined,
 *   ) // true
 *   hasValueSource(undefined, undefined) // false
 *
 * @param metadata - Column metadata that may contain a database default or generation.
 * @param schemaDefault - Default value from the Valibot schema.
 *
 * @returns `true` when the column has any value source
 */
function hasValueSource(
  metadata: ColumnMetadata | undefined,
  schemaDefault: unknown,
): boolean {
  return (
    metadata?.databaseDefault !== undefined ||
    metadata?.generation !== undefined ||
    schemaDefault !== undefined
  )
}

/**
 * Asserts optional NOT NULL columns have a default or generated value.
 *
 * @example
 *   validateOptionalColumn('users', 'status', optional(string()))
 *
 * @param tableName - Table name for error context.
 * @param columnName - Column name for error context.
 * @param colSchema - Column schema to validate.
 *
 * @throws SchemaError - When an optional NOT NULL column lacks a value source
 */
function validateOptionalColumn(
  tableName: string,
  columnName: string,
  colSchema: AnySchema,
): void {
  if (colSchema.type !== 'optional' || isSqlNullable(colSchema)) return

  const metadata = getColumnMetadata(colSchema)
  const schemaDefault = (colSchema as AnySchema & { default?: unknown }).default
  if (
    (metadata?.databaseDefault?.kind === 'literal' &&
      metadata.databaseDefault.value === null) ||
    schemaDefault === null
  ) {
    throw new SchemaError({
      message: `optional NOT NULL column "${columnName}" on table "${tableName}" cannot default to null`,
    })
  }

  if (!hasValueSource(metadata, schemaDefault)) {
    throw new SchemaError({
      message: `optional NOT NULL column "${columnName}" on table "${tableName}" requires a default or generated value`,
    })
  }
}

/**
 * Asserts every declared column's portable reference/storage rules are valid.
 *
 * @example
 *   validateColumns(schema, 'users')
 *
 * @param schema - Valibot object schema with column entries.
 * @param tableName - Table name for error context.
 *
 * @throws SchemaError - When portable column structure is invalid
 */
function validateColumns(schema: TableSchema, tableName: string): void {
  for (const [columnName, columnSchema] of Object.entries(schema.entries)) {
    const colSchema = columnSchema as AnySchema
    if (colSchema.kind !== 'schema') {
      continue
    }
    const ref = getReferenceMetadata(colSchema)
    validateOptionalColumn(tableName, columnName, colSchema)
    validateColumnOptions(tableName, columnName, colSchema)
    validateColumnReference(columnName, ref)
    const actions = [ref?.onDelete, ref?.onUpdate]
    if (actions.includes('set null') && !isSqlNullable(colSchema)) {
      throw new SchemaError({
        message: `reference on "${tableName}.${columnName}" uses SET NULL but local storage is NOT NULL`,
      })
    }
    if (actions.includes('set default')) {
      const columnMetadata = getColumnMetadata(colSchema)
      if (columnMetadata?.databaseDefault === undefined) {
        throw new SchemaError({
          message: `reference on "${tableName}.${columnName}" uses SET DEFAULT without a database default`,
        })
      }
    }
  }
}

/**
 * Asserts that table metadata is internally consistent before a handle is built.
 *
 * Checks the table name/schema, the primary key, every index, and each column's
 * portable column structure against the declared columns.
 *
 * @example
 *   validateTableMetadata(schema, metadata, ['id', 'name'])
 *
 * @param schema - Valibot object schema whose entries hold the column schemas.
 * @param metadata - Resolved `table()` metadata (name, schema, primaryKey, indexes)
 * @param columnNames - Declared column names that primary keys and indexes must
 *   reference.
 *
 * @throws SchemaError - When any name, key, index, or portable column rule is invalid
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

  validatePrimaryKey(schema, metadata, columnNames)
  validateIndexes(metadata, columnNames)
  validateColumns(schema, metadata.name)
}

/**
 * Validates Valibot table metadata and returns a table handle with typed column refs.
 *
 * @example
 *   const handle = buildTableHandle(schema)
 *   handle.getSchema() // the original schema
 *
 * @param schema - Valibot object schema with `title()` and `table()` metadata.
 *
 * @returns Table handle for registration, queries, and column references
 *
 * @throws SchemaError - When metadata is missing or invalid
 */
function buildTableHandle<
  S extends TableSchema,
  TSchema extends string | undefined = string | undefined,
>(schema: S): TableHandle<S, TSchema> {
  const metadata = getTableMetadata(schema)
  if (!metadata) {
    throw new SchemaError({
      message: 'defineTable requires table() metadata (name, primaryKey) on the schema',
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
    ...(columns as ColumnRefsOf<S, TSchema>),
    [TABLE_HANDLE]: true as const,
    /** Returns the original table schema. */
    getSchema: () => schema,
    /** Returns the validated table metadata. */
    getTableMetadata: () => metadata as TableMetadata<SchemaNameOf<S>>,
  }

  return handle as TableHandle<S, TSchema>
}

/**
 * Defines a table from a name, column map, and table options.
 *
 * Column values are Valibot schemas carrying `column()` / `reference()`
 * metadata. `primaryKey` and index `columns` are constrained to the declared
 * column names, so referencing an unknown column is a compile error.
 *
 * @example
 *   const User = defineTable(
 *     'users',
 *     {
 *       id: pipe(
 *         number(),
 *         column({ generation: { kind: 'identity', mode: 'byDefault' } }),
 *       ),
 *       email: pipe(
 *         string(),
 *         column({ physicalType: { postgresql: 'varchar(255)' }, unique: true }),
 *       ),
 *     },
 *     {
 *       schema: 'public',
 *       primaryKey: 'id',
 *       indexes: [{ columns: ['email'], unique: true }],
 *     },
 *   )
 *   User.email // column ref
 *
 * @param name - Database table name (also the logical name on column refs)
 * @param columns - Map of column name to Valibot column schema.
 * @param options - Primary key, optional DB schema, and indexes.
 *
 * @returns Table handle for registration, queries, and column references
 *
 * @throws SchemaError - When the resulting metadata is invalid
 */
export function defineTable<
  const TName extends string,
  TCols extends ObjectEntries,
  const TSchema extends string | undefined = undefined,
>(name: TName, columns: TCols, options: TableOptions<TCols, TSchema>) {
  const schema = pipe(object(columns), title(name), table({ name, ...options }))
  return buildTableHandle<typeof schema, TSchema>(schema)
}

/**
 * Type guard for values produced by `defineTable`.
 *
 * @example
 *   if (isTableHandle(value)) {
 *     const info = value.getTableMetadata()
 *   }
 *
 * @param value - Value to check.
 *
 * @returns `true` if `value` is a table handle from `defineTable`
 */
export function isTableHandle(value: unknown): value is TableHandle {
  return typeof value === 'object' && value !== null && TABLE_HANDLE in (value as object)
}
