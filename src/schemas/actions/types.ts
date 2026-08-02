import type { SQLDialect } from 'db0'
import type { ObjectEntries } from 'valibot'

/** Referential action for foreign-key ON DELETE / ON UPDATE. */
export type ReferentialAction =
  | 'cascade'
  | 'restrict'
  | 'no action'
  | 'set null'
  | 'set default'

/** Named or composite index definition. */
export type IndexConfig = {
  /** Explicit index name; dialect may generate one when omitted. */
  name?: string
  /** Columns participating in the index (order preserved) */
  columns: string[]
  /** Whether the index enforces uniqueness. */
  unique?: boolean
}

/** Index entry: a single column name, or a full index config. */
export type TableIndex = string | IndexConfig

/** Table-level metadata attached via `table()`. */
export type TableMetadata<N extends string = string> = {
  /** Discriminant for table metadata. */
  kind: 'table'
  /** Database table name. */
  name: N
  /** Primary key column name, or composite key column list. */
  primaryKey: string | string[]
  /** Indexes (string = single-column non-unique; object = named/composite/unique) */
  indexes?: TableIndex[]
  /** Database schema (Postgres namespace) */
  schema?: string
}

/** Column property names of a table's Valibot entries. */
export type ColumnKey<TCols extends ObjectEntries> = keyof TCols & string

/** Named or composite index definition constrained to a table's own columns. */
export type IndexConfigOf<TCols extends ObjectEntries> = {
  /** Explicit index name; dialect may generate one when omitted. */
  name?: string
  /** Columns participating in the index (order preserved) */
  columns: ColumnKey<TCols>[]
  /** Whether the index enforces uniqueness. */
  unique?: boolean
}

/**
 * Index entry constrained to a table's own columns: a single column name, or
 * a full index config.
 */
export type TableIndexOf<TCols extends ObjectEntries> =
  | ColumnKey<TCols>
  | IndexConfigOf<TCols>

/**
 * Table-level options passed to `defineTable(name, columns, options)`.
 * `primaryKey` and index `columns` are constrained to the declared columns.
 */
export type TableOptions<
  TCols extends ObjectEntries,
  TSchema extends string | undefined = string | undefined,
> = {
  /** Primary key column name, or composite key column list. */
  primaryKey: ColumnKey<TCols> | readonly ColumnKey<TCols>[]
  /** Database schema (Postgres namespace) */
  schema?: TSchema
  /** Indexes (string = single-column non-unique; object = named/composite/unique) */
  indexes?: TableIndexOf<TCols>[]
}

/** Primitive value stored as a database literal default. */
export type DatabaseLiteralValue = string | number | boolean | null

/** Closed set of database expressions with portable intent. */
export type PortableDatabaseExpression =
  | 'currentTimestamp'
  | 'currentDate'
  | 'currentTime'

/** Unambiguous database default intent. Valibot defaults remain application defaults. */
export type DatabaseDefault =
  | { readonly kind: 'literal'; readonly value: DatabaseLiteralValue }
  | {
      readonly kind: 'portableExpression'
      readonly expression: PortableDatabaseExpression
    }
  | {
      readonly kind: 'dialectExpression'
      readonly dialect: SQLDialect
      readonly expression: string
    }

/** Portable or selected-dialect expression used by generated columns. */
export type DatabaseExpression = Exclude<DatabaseDefault, { kind: 'literal' }>

/** Unambiguous database generation intent. */
export type ColumnGeneration =
  | {
      readonly kind: 'identity'
      readonly mode: 'always' | 'byDefault'
    }
  | {
      readonly kind: 'computed'
      readonly expression: DatabaseExpression
      readonly storage: 'stored' | 'virtual'
    }
  | {
      readonly kind: 'dialectGeneration'
      readonly dialect: SQLDialect
      readonly generation: string
    }

type TaggedColumnGeneration<M> = M extends { generation: infer G }
  ? Extract<G, ColumnGeneration>
  : never

type LegacyGeneratedColumnGeneration<M> = M extends { generated: infer G }
  ? Exclude<G, undefined> extends infer Mode
    ? Mode extends 'always' | 'byDefault'
      ? { readonly kind: 'identity'; readonly mode: Mode }
      : never
    : never
  : never

/** Canonical generation intent after tagged and legacy authoring fields are reconciled. */
export type NormalizedColumnGeneration<M> = [TaggedColumnGeneration<M>] extends [never]
  ? [LegacyGeneratedColumnGeneration<M>] extends [never]
    ? M extends { autoIncrement: true }
      ? { readonly kind: 'identity'; readonly mode: 'byDefault' }
      : never
    : LegacyGeneratedColumnGeneration<M>
  : TaggedColumnGeneration<M>

/** Dialect-keyed physical type overrides selected only by the active adapter. */
export type PhysicalTypeIntent = Readonly<Record<string, string>>

/** Column-level metadata attached via `column()`. */
export type ColumnMetadata = {
  /** Discriminant for column metadata. */
  kind: 'column'
  /** Legacy PostgreSQL physical type compatibility field. */
  type?: string
  /** Legacy PostgreSQL-compatible database default. */
  default?: string | number | boolean | null
  /** Tagged database default, distinct from Valibot application defaults. */
  databaseDefault?: DatabaseDefault
  /** Dialect-selectable physical type intent. */
  physicalType?: PhysicalTypeIntent
  /** Auto-increment column. */
  autoIncrement?: boolean
  /** Unique constraint. */
  unique?: boolean
  /** Column comment. */
  comment?: string
  /** Identity generation strategy. */
  generated?: 'byDefault' | 'always'
  /** Tagged database generation intent. */
  generation?: ColumnGeneration
  /** Immutable after insert. */
  readonly?: boolean
  /** SQL ON UPDATE expression (e.g. `'now()'`) */
  onUpdate?: string
  /** Override dialect mapping for values written as query params. */
  mapParam?: (value: unknown) => unknown
  /** Override dialect mapping for values read from result rows. */
  mapResult?: (value: unknown) => unknown
}

/** Foreign-key metadata attached via `reference()`. */
export type ReferenceMetadata = {
  /** Discriminant for reference metadata. */
  kind: 'reference'
  /**
   * Legacy schema/namespace projection of the referenced table.
   * Omitted means the selected registration default.
   */
  schema?: string
  /** Referenced table name. */
  table: string
  /** Referenced column name. */
  key: string
  /** Structured logical target retained until canonical graph registration. */
  target: {
    readonly relation: {
      readonly namespace?: readonly [
        { readonly role: 'schema'; readonly spelling: string },
      ]
      readonly relation: string
    }
    readonly column: string
  }
  /** ON DELETE action. */
  onDelete?: ReferentialAction
  /** ON UPDATE action. */
  onUpdate?: ReferentialAction
}
