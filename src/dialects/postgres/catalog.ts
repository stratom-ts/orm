import type {
  CatalogColumn,
  CatalogConstraintNameReservation,
  CatalogDiagnostic,
  CatalogExecutor,
  CatalogFact,
  CatalogForeignKey,
  CatalogIndex,
  CatalogKeyConstraint,
  CatalogNameReservation,
  CatalogNamespace,
  CatalogNoEvidence,
  CatalogRelation,
  CatalogRequest,
  CatalogSnapshot,
  CatalogTable,
  OpaqueCatalogObject,
  ResolvedCatalogRequest,
} from '@/dialects/catalog'
import type {
  CanonicalNamespaceSegment,
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
  CanonicalRelationRegistry,
} from '@/migrations/canonicalRelationIdentity'
import type { ReferentialAction } from '@/schemas/actions/types'
import { toNumberOrNull } from '@/utils'
import { InvariantError, MigrationError } from '@/utils/error'

import { postgresIdentity } from './identity'
import {
  normalizePostgresDataType,
  normalizePostgresDefaultExpression,
} from './normalize'

const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const POSTGRES_CONSTRAINT_CATALOG_SQL = `
      select n.nspname as schema, tbl.relname as table_name, con.conname as constraint_name,
             con.contype as constraint_type, con.convalidated as is_valid,
             con.condeferrable as is_deferrable, con.condeferred as initially_deferred,
             con.confmatchtype as match_type,
             case
               when jsonb_typeof(to_jsonb(con) -> 'confdelsetcols') = 'array'
                 then jsonb_array_length(to_jsonb(con) -> 'confdelsetcols') > 0
               else false
             end as has_column_specific_delete_action,
             (backing_index.indisvalid and backing_index.indisready) as backing_index_is_valid,
             coalesce((to_jsonb(backing_index) ->> 'indnullsnotdistinct')::boolean, false) as backing_index_nulls_not_distinct,
             (backing_am.amname = 'btree' and backing_index.indpred is null
               and backing_index.indexprs is null
               and backing_index.indnkeyatts = backing_index.indnatts
               and not coalesce((to_jsonb(backing_index) ->> 'indnullsnotdistinct')::boolean, false)
               and not exists (
                 select 1 from unnest(backing_index.indoption) as option(value)
                 where option.value <> 0
               )
               and not exists (
                 select 1
                 from unnest(backing_index.indclass) as opclass(oid)
                 join pg_opclass opc on opc.oid = opclass.oid
                 where not opc.opcdefault or opc.opcmethod <> backing_am.oid
               )
               and not exists (
                 select 1
                 from unnest(backing_index.indcollation, backing_index.indkey)
                   as indexed(collation_oid, attnum)
                 join pg_attribute a
                   on a.attrelid = tbl.oid and a.attnum = indexed.attnum
                 where indexed.collation_oid <> 0
                   and indexed.collation_oid <> a.attcollation
               )
             ) as has_supported_backing_index_semantics,
             (select coalesce(array_agg(a.attname order by x.ordinality), '{}')
                from unnest(con.conkey) with ordinality as x(attnum, ordinality)
                join pg_attribute a on a.attrelid = tbl.oid and a.attnum = x.attnum) as columns,
             ref_n.nspname as referenced_schema, ref_tbl.relname as referenced_table,
             (select coalesce(array_agg(a.attname order by x.ordinality), '{}')
                from unnest(con.confkey) with ordinality as x(attnum, ordinality)
                join pg_attribute a on a.attrelid = ref_tbl.oid and a.attnum = x.attnum) as referenced_columns,
             case con.confdeltype when 'c' then 'cascade' when 'r' then 'restrict'
               when 'n' then 'set null' when 'd' then 'set default' else 'no action' end as on_delete,
             case con.confupdtype when 'c' then 'cascade' when 'r' then 'restrict'
               when 'n' then 'set null' when 'd' then 'set default' else 'no action' end as on_update,
             pg_get_constraintdef(con.oid, true) as native_definition
      from pg_constraint con
      join pg_class tbl on tbl.oid = con.conrelid
      join pg_namespace n on n.oid = tbl.relnamespace
      left join pg_class ref_tbl on ref_tbl.oid = con.confrelid
      left join pg_namespace ref_n on ref_n.oid = ref_tbl.relnamespace
      left join pg_index backing_index on backing_index.indexrelid = con.conindid
      left join pg_class backing_class on backing_class.oid = con.conindid
      left join pg_am backing_am on backing_am.oid = backing_class.relam
      where n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname = any($1::text[])
      order by n.nspname, tbl.relname, con.conname
    `

const POSTGRES_INDEX_CATALOG_SQL = `
      select n.nspname as schema, tbl.relname as table_name, idx.relname as index_name,
             i.indisunique as is_unique, (i.indisvalid and i.indisready) as is_valid,
             coalesce((to_jsonb(i) ->> 'indnullsnotdistinct')::boolean, false) as nulls_not_distinct,
             (am.amname = 'btree' and i.indpred is null and i.indexprs is null
               and i.indnkeyatts = i.indnatts
               and not coalesce((to_jsonb(i) ->> 'indnullsnotdistinct')::boolean, false)
               and not exists (
                 select 1 from unnest(i.indoption) as option(value)
                 where option.value <> 0
               )
               and not exists (
                 select 1
                 from unnest(i.indclass) as opclass(oid)
                 join pg_opclass opc on opc.oid = opclass.oid
                 where not opc.opcdefault or opc.opcmethod <> am.oid
               )
               and not exists (
                 select 1
                 from unnest(i.indcollation, i.indkey) as indexed(collation_oid, attnum)
                 join pg_attribute a
                   on a.attrelid = tbl.oid and a.attnum = indexed.attnum
                 where indexed.collation_oid <> 0
                   and indexed.collation_oid <> a.attcollation
               )
             ) as has_supported_semantics,
             (select coalesce(array_agg(a.attname order by x.ordinality), '{}')
                from unnest(i.indkey) with ordinality as x(attnum, ordinality)
                join pg_attribute a on a.attrelid = tbl.oid and a.attnum = x.attnum) as columns,
             pg_get_indexdef(i.indexrelid) as native_definition
      from pg_index i
      join pg_class idx on idx.oid = i.indexrelid
      join pg_class tbl on tbl.oid = i.indrelid
      join pg_namespace n on n.oid = tbl.relnamespace
      join pg_am am on am.oid = idx.relam
      where n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname = any($1::text[])
        and tbl.relkind in ('r', 'p') and not i.indisprimary
        and not exists (select 1 from pg_constraint con where con.conindid = i.indexrelid)
      order by n.nspname, tbl.relname, idx.relname
    `

const POSTGRES_OPAQUE_CATALOG_SQL = `
      select n.nspname as schema, c.relname as table_name, 'trigger' as object_kind,
             t.tgname as object_name,
             pg_get_triggerdef(t.oid, true) as native_definition
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal and n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname = any($1::text[])
      union all
      select n.nspname, c.relname, 'policy', p.polname,
             format(
               'policy %I on %I.%I as %s for %s to %s using (%s) with check (%s)',
               p.polname,
               n.nspname,
               c.relname,
               case when p.polpermissive then 'permissive' else 'restrictive' end,
               case p.polcmd
                 when 'r' then 'select'
                 when 'a' then 'insert'
                 when 'w' then 'update'
                 when 'd' then 'delete'
                 else 'all'
               end,
               (
                 select string_agg(
                   case role when 0 then 'public' else quote_ident(pg_get_userbyid(role)) end,
                   ', ' order by role
                 )
                 from unnest(p.polroles) as role
               ),
               coalesce(pg_get_expr(p.polqual, p.polrelid), ''),
               coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
             )
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname = any($1::text[])
      union all
      select n.nspname, c.relname, 'other', r.rulename,
             pg_get_ruledef(r.oid, true)
      from pg_rewrite r
      join pg_class c on c.oid = r.ev_class
      join pg_namespace n on n.oid = c.relnamespace
      where r.rulename <> '_RETURN'
        and n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname = any($1::text[])
      order by 1, 2, 3, 4
    `

type Row = Record<string, unknown>

const complete = { state: 'complete' } as const
const absent = { state: 'absent' } as const

/**
 * Wraps a catalog value as present evidence.
 *
 * @param value - Catalog value to wrap.
 */
function present<T>(value: T): CatalogFact<T> {
  return { state: 'present', value }
}

/**
 * Creates adapter-level unsupported evidence.
 *
 * @param reason - Reason the adapter cannot provide evidence.
 */
function unsupported(reason: string): CatalogNoEvidence {
  return { state: 'unsupported', by: 'adapter', reason }
}

/**
 * Compares strings by UTF-16 code-unit order.
 *
 * @param left - Left string.
 * @param right - Right string.
 */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1

  return 0
}

/**
 * Serializes an observation with stable object-key ordering.
 *
 * @param value - Observation to serialize.
 */
function stableObservation(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableObservation).join(',')}]`

  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableObservation(item)}`)
      .join(',')}}`
  }

  if (typeof value === 'bigint') return JSON.stringify(value.toString())

  return JSON.stringify(value)
}

/**
 * Rejects catalog observations that changed between reads.
 *
 * @param description - Human-readable observation kind.
 * @param first - Initial observation rows.
 * @param second - Repeated observation rows.
 */
function assertObservationUnchanged(
  description: string,
  first: unknown[],
  second: unknown[],
): void {
  if (stableObservation(first) !== stableObservation(second)) {
    throw new MigrationError({
      message: `PostgreSQL catalog changed during introspection: ${description} observations differ`,
      stage: 'introspection',
      outcome: 'unchanged',
      retryable: true,
    })
  }
}

/**
 * Validates and returns one catalog query row.
 *
 * @param value - Raw row value.
 * @param query - Query name for diagnostics.
 * @param index - Row index for diagnostics.
 */
function rowAt(value: unknown, query: string, index: number): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvariantError(
      `Malformed PostgreSQL ${query} row ${index}: expected an object`,
    )
  }

  return value as Row
}

/**
 * Reads a required non-empty string field from a row.
 *
 * @param row - Catalog row.
 * @param key - Field name.
 * @param query - Query name for diagnostics.
 * @param index - Row index for diagnostics.
 */
function stringAt(row: Row, key: string, query: string, index: number): string {
  const value = row[key]

  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    UNPAIRED_SURROGATE.test(value)
  ) {
    throw new InvariantError(
      `Malformed PostgreSQL ${query} row ${index}: ${JSON.stringify(key)} must be a non-empty string`,
    )
  }

  return value
}

/**
 * Reads a nullable string field from a row.
 *
 * @param row - Catalog row.
 * @param key - Field name.
 * @param query - Query name for diagnostics.
 * @param index - Row index for diagnostics.
 */
function nullableStringAt(
  row: Row,
  key: string,
  query: string,
  index: number,
): string | null {
  const value = row[key]

  if (value === null) return null

  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    UNPAIRED_SURROGATE.test(value)
  ) {
    throw new InvariantError(
      `Malformed PostgreSQL ${query} row ${index}: ${JSON.stringify(key)} must be a string or null`,
    )
  }

  return value
}

/**
 * Reads a PostgreSQL boolean representation from a row.
 *
 * @param row - Catalog row.
 * @param key - Field name.
 * @param query - Query name for diagnostics.
 * @param index - Row index for diagnostics.
 */
function booleanAt(row: Row, key: string, query: string, index: number): boolean {
  const value = row[key]

  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'YES' || value === 't') return true
  if (value === 0 || value === '0' || value === 'NO' || value === 'f') return false

  throw new InvariantError(
    `Malformed PostgreSQL ${query} row ${index}: ${JSON.stringify(key)} must be boolean`,
  )
}

/**
 * Reads a positive integer field from a row.
 *
 * @param row - Catalog row.
 * @param key - Field name.
 * @param query - Query name for diagnostics.
 * @param index - Row index for diagnostics.
 */
function positiveIntegerAt(row: Row, key: string, query: string, index: number): number {
  const value = toNumberOrNull(row[key])

  if (value === null || !Number.isInteger(value) || value < 1) {
    throw new InvariantError(
      `Malformed PostgreSQL ${query} row ${index}: ${JSON.stringify(key)} must be a positive integer`,
    )
  }

  return value
}

/** Parses a JSON string array when the text has a JSON array shape. */
function jsonStringArray(value: string): string[] | undefined {
  if (!value.startsWith('[') || !value.endsWith(']')) return undefined

  try {
    const parsed = JSON.parse(value) as unknown

    if (
      Array.isArray(parsed) &&
      parsed.every((item): item is string => typeof item === 'string')
    )
      return parsed
  } catch {
    // The caller reports the canonical query and row location.
  }

  return undefined
}

/** Parses one-dimensional PostgreSQL text-array syntax containing only strings. */
function postgresStringArray(value: string): string[] | undefined {
  if (!value.startsWith('{') || !value.endsWith('}')) return undefined

  const inner = value.slice(1, -1)

  if (inner.length === 0) return []

  const parts: string[] = []
  const quotedParts: boolean[] = []
  let part = ''
  let quoted = false
  let partWasQuoted = false
  let escaped = false

  for (const character of inner) {
    if (escaped) {
      part += character
      escaped = false
    } else if (character === '\\') escaped = true
    else if (character === '"') {
      quoted = !quoted
      partWasQuoted = true
    } else if (character === ',' && !quoted) {
      quotedParts.push(partWasQuoted)
      parts.push(partWasQuoted ? part : part.trim())
      part = ''
      partWasQuoted = false
    } else part += character
  }

  if (quoted || escaped) return undefined

  quotedParts.push(partWasQuoted)
  parts.push(partWasQuoted ? part : part.trim())

  if (
    parts.every(
      (item, index) => item.length > 0 && (quotedParts[index] || item !== 'NULL'),
    )
  )
    return parts

  return undefined
}

/**
 * Reads a string array from native, JSON, or PostgreSQL array syntax.
 *
 * @param row - Catalog row.
 * @param key - Field name.
 * @param query - Query name for diagnostics.
 * @param index - Row index for diagnostics.
 */
function stringArrayAt(row: Row, key: string, query: string, index: number): string[] {
  const value = row[key]

  if (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === 'string')
  )
    return [...value]

  if (typeof value === 'string') {
    const trimmed = value.trim()
    const parsed = jsonStringArray(trimmed) ?? postgresStringArray(trimmed)

    if (parsed) return parsed
  }

  throw new InvariantError(
    `Malformed PostgreSQL ${query} row ${index}: ${JSON.stringify(key)} must contain only string members`,
  )
}

/**
 * Tests canonical namespace equality.
 *
 * @param left - Left namespace.
 * @param right - Right namespace.
 */
function sameNamespace(
  left: readonly CanonicalNamespaceSegment[],
  right: readonly CanonicalNamespaceSegment[],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => {
      const other = right.at(index)!
      return (
        segment.role === other.role &&
        segment.identifier.comparisonKey === other.identifier.comparisonKey
      )
    })
  )
}

/**
 * Builds a PostgreSQL relation identity input.
 *
 * @param schema - Schema spelling.
 * @param relation - Relation spelling.
 */
function relationInput(schema: string, relation: string) {
  return {
    namespace: [{ role: 'schema' as const, spelling: schema }],
    relation,
  }
}

/**
 * Compares canonical namespaces deterministically.
 *
 * @param left - Left namespace.
 * @param right - Right namespace.
 */
function compareNamespaces(
  left: readonly CanonicalNamespaceSegment[],
  right: readonly CanonicalNamespaceSegment[],
): number {
  const length = Math.min(left.length, right.length)

  for (let index = 0; index < length; index++) {
    const leftSegment = left[index]
    const rightSegment = right[index]
    const role = compareCodeUnits(leftSegment.role, rightSegment.role)

    if (role !== 0) return role

    const identifier = compareCodeUnits(
      leftSegment.identifier.comparisonKey,
      rightSegment.identifier.comparisonKey,
    )

    if (identifier !== 0) return identifier
  }

  return left.length - right.length
}

/**
 * Resolves and deduplicates a catalog request against session identities.
 *
 * @param request - Authored catalog request.
 * @param identities - PostgreSQL canonical identity module.
 */
function resolveRequest(
  request: CatalogRequest,
  identities: CanonicalRelationIdentityModule,
): ResolvedCatalogRequest {
  const relationMap =
    identities.createRegistry<ResolvedCatalogRequest['relations'][number]>()

  for (const relation of request.relations) {
    const identity = identities.resolve(relation.relation)
    relationMap.set(identity, { identity, shape: relation.shape })
  }

  const relations = request.relations
    .map(({ relation }) => relationMap.get(identities.resolve(relation))!)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => identities.compare(left.identity, right.identity))

  const absentMap = identities.createRegistry<CanonicalRelationIdentity>()

  for (const input of request.absentRelations) {
    const identity = identities.resolve(input)
    absentMap.set(identity, identity)
  }

  const absentRelations = request.absentRelations
    .map((input) => absentMap.get(identities.resolve(input))!)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((a, b) => identities.compare(a, b))

  const completeNamespaces = request.completeNamespaces
    .map((namespace) => identities.resolveNamespace(namespace))
    .filter(
      (namespace, index, values) =>
        values.findIndex((candidate) => sameNamespace(candidate, namespace)) === index,
    )
    .sort(compareNamespaces)

  return { relations, absentRelations, completeNamespaces }
}

/**
 * Collects unique namespaces covered by a resolved request.
 *
 * @param request - Resolved catalog request.
 */
function requestedNamespaces(request: ResolvedCatalogRequest) {
  return [
    ...request.relations.map(({ identity }) => identity.namespace),
    ...request.absentRelations.map((identity) => identity.namespace),
    ...request.completeNamespaces,
  ].filter(
    (namespace, index, values) =>
      values.findIndex((candidate) => sameNamespace(candidate, namespace)) === index,
  )
}

/** Indexes every explicitly requested or explicitly absent relation. */
function requestedRelationRegistry(
  request: ResolvedCatalogRequest,
  identities: CanonicalRelationIdentityModule,
): CanonicalRelationRegistry<true> {
  const requested = identities.createRegistry<true>()

  for (const { identity } of request.relations) requested.set(identity, true)
  for (const identity of request.absentRelations) requested.set(identity, true)
  return requested
}

const POSTGRES_CATALOG_TYPE_ALIASES = new Map([
  ['int2', 'smallint'],
  ['int4', 'integer'],
  ['int8', 'bigint'],
  ['bool', 'boolean'],
  ['float4', 'real'],
  ['float8', 'double precision'],
  ['timestamptz', 'timestamptz'],
  ['timestamp', 'timestamp'],
])

/**
 * Reconstructs a PostgreSQL catalog column type.
 *
 * @param row - Column catalog row.
 * @param query - Query name for diagnostics.
 * @param index - Row index for diagnostics.
 */
function formatPostgresCatalogDataType(row: Row, query: string, index: number): string {
  if (typeof row.formatted_type === 'string' && row.formatted_type.length > 0)
    return row.formatted_type

  const dataType = stringAt(row, 'data_type', query, index).toLowerCase()
  const udt = stringAt(row, 'udt_name', query, index).toLowerCase()
  const maxLen = toNumberOrNull(row.character_maximum_length)
  const precision = toNumberOrNull(row.numeric_precision)
  const scale = toNumberOrNull(row.numeric_scale)

  if (['character varying', 'varchar'].includes(dataType) || udt === 'varchar')
    return maxLen !== null ? `varchar(${maxLen})` : 'varchar'

  if (['character', 'char'].includes(dataType) || udt === 'bpchar')
    return maxLen !== null ? `char(${maxLen})` : 'char'

  if (dataType === 'numeric' || dataType === 'decimal') {
    if (precision !== null && scale !== null) return `numeric(${precision},${scale})`
    if (precision !== null) return `numeric(${precision})`

    return 'numeric'
  }

  const alias = POSTGRES_CATALOG_TYPE_ALIASES.get(udt)

  if (alias) return alias
  if (dataType === 'timestamp without time zone') return 'timestamp'
  if (dataType === 'timestamp with time zone') return 'timestamptz'

  return udt || dataType
}

/**
 * Validates a PostgreSQL referential action.
 *
 * @param value - Catalog action value.
 * @param query - Query name for diagnostics.
 * @param index - Row index for diagnostics.
 */
function referentialAction(
  value: string,
  query: string,
  index: number,
): ReferentialAction {
  if (
    value === 'no action' ||
    value === 'restrict' ||
    value === 'cascade' ||
    value === 'set null' ||
    value === 'set default'
  )
    return value

  throw new InvariantError(`Malformed PostgreSQL ${query} row ${index}: invalid action`)
}

/**
 * Maps a PostgreSQL relation kind code to the catalog model.
 *
 * @param value - PostgreSQL relkind code.
 */
function relationKind(value: string) {
  if (value === 'r') return 'table' as const
  if (value === 'p') return 'partitionedTable' as const
  if (value === 'v') return 'view' as const
  if (value === 'm') return 'materializedView' as const
  if (value === 'f') return 'foreignTable' as const

  throw new InvariantError(
    `Malformed PostgreSQL relation row: unsupported relkind ${value}`,
  )
}

/**
 * Maps a PostgreSQL persistence code to the catalog model.
 *
 * @param value - PostgreSQL relpersistence code.
 */
function persistence(value: string) {
  if (value === 'p') return 'permanent' as const
  if (value === 't') return 'temporary' as const
  if (value === 'u') return 'unlogged' as const

  throw new InvariantError(
    `Malformed PostgreSQL relation row: unsupported persistence ${value}`,
  )
}

/**
 * Extracts the required physical name from catalog evidence.
 *
 * @param fact - Catalog name evidence.
 */
function factName(fact: CatalogFact<string>): string {
  if (fact.state !== 'present') {
    throw new InvariantError(
      'PostgreSQL catalog object is missing its required physical name',
    )
  }

  return fact.value
}

type MutableTable = {
  columns: CatalogColumn[]
  primaryKey: CatalogFact<CatalogKeyConstraint>
  uniqueConstraints: CatalogKeyConstraint[]
  foreignKeys: CatalogForeignKey[]
  indexes: CatalogIndex[]
  options: Readonly<{ name: string; value: string }>[]
  opaqueObjects: OpaqueCatalogObject[]
}

type MutableRelation = {
  relation: Omit<CatalogRelation, 'table'>
  table?: MutableTable
}

type RequestedTable = Readonly<{
  identity: CanonicalRelationIdentity
  table: MutableTable
}>

type RequireTable = (row: Row, query: string, index: number) => RequestedTable | undefined

/** Builds the mutable table shape used while catalog member rows are assembled. */
function mutableTableForRelation(
  kind: CatalogRelation['kind'],
  row: Row,
  index: number,
): MutableTable | undefined {
  if (kind !== 'table' && kind !== 'partitionedTable') return undefined

  const { partitionKey, accessMethod, tablespace, partitionBound } =
    readPostgresTableOptions(row, index)

  return {
    columns: [],
    primaryKey: absent,
    uniqueConstraints: [],
    foreignKeys: [],
    indexes: [],
    options: [
      ...stringArrayAt(row, 'options', 'relation', index).map((option) => {
        const separator = option.indexOf('=')
        return separator < 0
          ? { name: option, value: '' }
          : {
              name: option.slice(0, separator),
              value: option.slice(separator + 1),
            }
      }),
      ...(partitionKey === null ? [] : [{ name: 'partitionKey', value: partitionKey }]),
      {
        name: 'rowLevelSecurity',
        value: String(booleanAt(row, 'row_level_security', 'relation', index)),
      },
      {
        name: 'forceRowLevelSecurity',
        value: String(booleanAt(row, 'force_row_level_security', 'relation', index)),
      },
      {
        name: 'replicaIdentity',
        value: stringAt(row, 'replica_identity', 'relation', index),
      },
      ...(accessMethod === null ? [] : [{ name: 'accessMethod', value: accessMethod }]),
      ...(tablespace === null ? [] : [{ name: 'tablespace', value: tablespace }]),
      ...(partitionBound === null
        ? []
        : [{ name: 'partitionBound', value: partitionBound }]),
    ],
    opaqueObjects: [],
  }
}

/**
 * Decodes native relation options that affect catalog management.
 *
 * @param row - Current native catalog row, insert row, or result object.
 * @param index - Zero-based row, column, or graph position used for ordering and
 *   diagnostics.
 *
 * @returns Native relation options that affect catalog management.
 */
function readPostgresTableOptions(row: Row, index: number) {
  const partitionKey = nullableStringAt(row, 'partition_key', 'relation', index)
  const accessMethod = nullableStringAt(row, 'access_method', 'relation', index)
  const tablespace = nullableStringAt(row, 'tablespace', 'relation', index)
  const isPartition = booleanAt(row, 'is_partition', 'relation', index)
  const partitionBound = nullableStringAt(row, 'partition_bound', 'relation', index)

  if (isPartition && partitionBound === null) {
    throw new InvariantError(
      `Malformed PostgreSQL relation row ${index}: partition is missing its bound`,
    )
  }

  return { partitionKey, accessMethod, tablespace, partitionBound }
}

/** Creates the requested relation registry before member rows are attached. */
function createRelationRegistry(
  rows: unknown[],
  relationRequested: (identity: CanonicalRelationIdentity) => boolean,
  identities: CanonicalRelationIdentityModule,
): CanonicalRelationRegistry<MutableRelation> {
  const registry = identities.createRegistry<MutableRelation>()

  for (let index = 0; index < rows.length; index++) {
    const row = rowAt(rows[index], 'relation', index)
    const identity = identities.resolve(
      relationInput(
        stringAt(row, 'schema', 'relation', index),
        stringAt(row, 'name', 'relation', index),
      ),
    )

    if (!relationRequested(identity)) continue

    if (registry.has(identity)) {
      throw new InvariantError(
        `Duplicate PostgreSQL relation row for ${identities.format(identity)}`,
      )
    }

    const kind = relationKind(stringAt(row, 'relation_kind', 'relation', index))
    const native = nullableStringAt(row, 'native_definition', 'relation', index)
    registry.set(identity, {
      table: mutableTableForRelation(kind, row, index),
      relation: {
        identity,
        kind,
        persistence: persistence(stringAt(row, 'persistence', 'relation', index)),
        owner: present(stringAt(row, 'owner', 'relation', index)),
        management: 'managed',
        nativeDefinition:
          native === null
            ? unsupported('PostgreSQL does not expose canonical CREATE relation SQL')
            : present(native),
      },
    })
  }

  return registry
}

/** Reports whether one PostgreSQL constraint has portable semantics. */
function hasSupportedConstraintSemantics(row: Row, type: string, index: number): boolean {
  if (booleanAt(row, 'is_deferrable', 'constraint', index)) return false
  if (booleanAt(row, 'initially_deferred', 'constraint', index)) return false

  if (type === 'p' || type === 'u') {
    return (
      booleanAt(row, 'has_supported_backing_index_semantics', 'constraint', index) &&
      !booleanAt(row, 'backing_index_nulls_not_distinct', 'constraint', index)
    )
  }

  if (type !== 'f') return true

  return (
    stringAt(row, 'match_type', 'constraint', index) === 's' &&
    !booleanAt(row, 'has_column_specific_delete_action', 'constraint', index)
  )
}

/** Reports whether one PostgreSQL constraint and its backing index are valid. */
function constraintIsValid(row: Row, type: string, index: number): boolean {
  if (!booleanAt(row, 'is_valid', 'constraint', index)) return false
  if (type !== 'p' && type !== 'u') return true

  return booleanAt(row, 'backing_index_is_valid', 'constraint', index)
}

/** Attaches primary, unique, foreign, and opaque constraints to requested tables. */
function appendConstraints(
  rows: unknown[],
  requireTable: RequireTable,
  identities: CanonicalRelationIdentityModule,
  reservations: CatalogConstraintNameReservation[],
): void {
  for (let index = 0; index < rows.length; index++) {
    const row = rowAt(rows[index], 'constraint', index)
    const target = requireTable(row, 'constraint', index)

    if (!target) continue

    const type = stringAt(row, 'constraint_type', 'constraint', index)
    const name = stringAt(row, 'constraint_name', 'constraint', index)
    reservations.push({ relation: target.identity, name })
    // PostgreSQL 18 records column NOT NULL declarations in pg_constraint too.
    // Validated column nullability already carries this portable evidence, so
    // retain the name reservation without duplicating the constraint as opaque.

    if (type === 'n' && booleanAt(row, 'is_valid', 'constraint', index)) continue

    appendDecodedConstraint(row, index, type, name, target, identities)
  }
}

/**
 * Attaches a decoded primary, unique, foreign, or opaque constraint to its table.
 *
 * @param row - Current native catalog row, insert row, or result object.
 * @param index - Zero-based row, column, or graph position used for ordering and
 *   diagnostics.
 * @param type - Physical type spelling used to build storage evidence.
 * @param name - Physical identifier or dialect label used by this operation.
 * @param target - Identity or evidence required by the current reference or diagnostic.
 * @param identities - Canonical identity operations for the resolved namespace context.
 */
function appendDecodedConstraint(
  row: Row,
  index: number,
  type: string,
  name: string,
  target: Readonly<{ identity: CanonicalRelationIdentity; table: MutableTable }>,
  identities: CanonicalRelationIdentityModule,
) {
  const { key, nativeDefinition } = decodeConstraintKey(row, index, type, name)

  if (type === 'p' && target.table.primaryKey.state !== 'absent') {
    throw new InvariantError(
      `Duplicate PostgreSQL primary key for ${identities.format(target.identity)}`,
    )
  }

  if (
    type === 'f' &&
    (typeof row.referenced_schema !== 'string' ||
      typeof row.referenced_table !== 'string')
  ) {
    throw new InvariantError(
      `PostgreSQL foreign key ${JSON.stringify(name)} on ${identities.format(target.identity)} is missing referenced relation metadata`,
    )
  }

  if (type === 'p') target.table.primaryKey = present(key)
  else if (type === 'u') target.table.uniqueConstraints.push(key)
  else if (type === 'f')
    target.table.foreignKeys.push(decodePostgresForeignKey(row, index, identities, key))
  else {
    target.table.opaqueObjects.push({
      kind: 'constraint',
      name: present(name),
      nativeDefinition: present(nativeDefinition),
      reason: `PostgreSQL constraint type ${JSON.stringify(type)} is not portable`,
    })
  }
}

/**
 * Decodes ordered key columns, names, validity, and supported native semantics.
 *
 * @param row - Current native catalog row, insert row, or result object.
 * @param index - Zero-based row, column, or graph position used for ordering and
 *   diagnostics.
 * @param type - Physical type spelling used to build storage evidence.
 * @param name - Physical identifier or dialect label used by this operation.
 *
 * @returns Ordered key columns, names, validity, and supported native semantics.
 */
function decodeConstraintKey(row: Row, index: number, type: string, name: string) {
  const nativeDefinition = stringAt(row, 'native_definition', 'constraint', index)
  const supported = hasSupportedConstraintSemantics(row, type, index)
  const valid = constraintIsValid(row, type, index)
  const key: CatalogKeyConstraint = {
    name: present(name),
    columns: stringArrayAt(row, 'columns', 'constraint', index),
    semantics: supported
      ? present({ kind: 'simple' })
      : unsupported('Constraint uses PostgreSQL-native semantics'),
    validity: present(valid ? 'valid' : 'invalid'),
    nativeDefinition: present(nativeDefinition),
  }

  return { key, nativeDefinition }
}

/** Attaches portable index observations to requested tables. */
function appendIndexes(rows: unknown[], requireTable: RequireTable): void {
  for (let index = 0; index < rows.length; index++) {
    const row = rowAt(rows[index], 'index', index)
    const target = requireTable(row, 'index', index)

    if (!target) continue

    const supported =
      booleanAt(row, 'has_supported_semantics', 'index', index) &&
      !booleanAt(row, 'nulls_not_distinct', 'index', index)

    target.table.indexes.push({
      name: present(stringAt(row, 'index_name', 'index', index)),
      origin: 'user',
      columns: stringArrayAt(row, 'columns', 'index', index),
      unique: booleanAt(row, 'is_unique', 'index', index),
      semantics: supported
        ? present({ kind: 'simple' })
        : unsupported('Index uses PostgreSQL-native semantics'),
      validity: present(booleanAt(row, 'is_valid', 'index', index) ? 'valid' : 'invalid'),
      nativeDefinition: present(stringAt(row, 'native_definition', 'index', index)),
    })
  }
}

/** Attaches catalog objects outside the portable model to requested tables. */
function appendOpaqueObjects(rows: unknown[], requireTable: RequireTable): void {
  for (let index = 0; index < rows.length; index++) {
    const row = rowAt(rows[index], 'opaque object', index)
    const target = requireTable(row, 'opaque object', index)

    if (!target) continue

    const kind = stringAt(row, 'object_kind', 'opaque object', index)

    if (kind !== 'trigger' && kind !== 'policy' && kind !== 'other') {
      throw new InvariantError(
        `Malformed PostgreSQL opaque object row ${index}: unsupported kind ${JSON.stringify(kind)}`,
      )
    }

    target.table.opaqueObjects.push({
      kind,
      name: present(stringAt(row, 'object_name', 'opaque object', index)),
      nativeDefinition: present(
        stringAt(row, 'native_definition', 'opaque object', index),
      ),
      reason: `PostgreSQL ${kind} is not managed by the portable schema model`,
    })
  }
}

/** Converts validated PostgreSQL generation metadata to portable catalog evidence. */
function columnGeneration(
  isIdentity: boolean,
  identityGeneration: string | null,
  generated: string,
  generationExpression: string | null,
): CatalogColumn['generation'] {
  if (generated === 'ALWAYS') {
    return present({
      kind: 'computed',
      storage: 'stored',
      expression: generationExpression!,
    })
  }

  if (isIdentity) {
    return present({
      kind: 'identity',
      mode: identityGeneration === 'ALWAYS' ? 'always' : 'byDefault',
    })
  }

  return absent
}

/** Attaches ordered column observations to requested tables. */
function appendColumns(
  rows: unknown[],
  requireTable: RequireTable,
  identities: CanonicalRelationIdentityModule,
): void {
  for (let index = 0; index < rows.length; index++) {
    const row = rowAt(rows[index], 'column', index)
    const target = requireTable(row, 'column', index)

    if (!target) continue

    target.table.columns.push(decodePostgresColumn(row, index, identities))
  }
}

/** Builds the PostgreSQL constraint evidence query for the requested schemas. */
function createConstraintQuery(scopeSchemas: readonly string[]) {
  const constraintQuery = {
    sql: POSTGRES_CONSTRAINT_CATALOG_SQL,
    params: [scopeSchemas],
  }

  return constraintQuery
}

/** Builds the queries for the requested PostgreSQL schemas. */
function createCatalogQueries(scopeSchemas: readonly string[]) {
  const namespaceQuery = {
    sql: POSTGRES_NAMESPACE_CATALOG_SQL,
    params: [scopeSchemas],
  }

  const relationQuery = {
    sql: POSTGRES_RELATION_CATALOG_SQL,
    params: [scopeSchemas],
  }

  const columnQuery = {
    sql: POSTGRES_COLUMN_CATALOG_SQL,
    params: [scopeSchemas],
  }

  const constraintQuery = createConstraintQuery(scopeSchemas)

  const indexQuery = {
    sql: POSTGRES_INDEX_CATALOG_SQL,
    params: [scopeSchemas],
  }

  const opaqueQuery = {
    sql: POSTGRES_OPAQUE_CATALOG_SQL,
    params: [scopeSchemas],
  }

  const reservationQuery = {
    sql: POSTGRES_RESERVATION_CATALOG_SQL,
    params: [scopeSchemas],
  }

  return {
    namespaceQuery,
    relationQuery,
    columnQuery,
    constraintQuery,
    indexQuery,
    opaqueQuery,
    reservationQuery,
  }
}

/** Resolves the PostgreSQL session namespace, version, and catalog request. */
async function readCatalogContext(executor: CatalogExecutor, request: CatalogRequest) {
  const contextRows = await executor.execute({
    sql: `
      select current_database() as database,
             current_schema() as schema,
             current_setting('server_version_num') as version
    `,
    params: [],
  })

  if (contextRows.length !== 1) {
    throw new InvariantError(
      'PostgreSQL introspection could not resolve a writable namespace',
    )
  }

  const contextRow = rowAt(contextRows[0], 'context', 0)
  const database = stringAt(contextRow, 'database', 'context', 0)
  const schema = stringAt(contextRow, 'schema', 'context', 0)
  const version = stringAt(contextRow, 'version', 'context', 0)
  const versionNumber = Number(version)

  if (!/^\d+$/.test(version) || !Number.isSafeInteger(versionNumber)) {
    throw new InvariantError(
      'Malformed PostgreSQL context row 0: "version" must be numeric',
    )
  }

  const namespaceContext = {
    writableDefault: [
      { role: 'database' as const, spelling: database },
      { role: 'schema' as const, spelling: schema },
    ],
  }

  const identities = postgresIdentity.create({
    context: namespaceContext,
    ...(request.registrationDefault === undefined
      ? {}
      : { registrationDefault: request.registrationDefault }),
  })

  const resolvedRequest = resolveRequest(request, identities)
  return { version, versionNumber, namespaceContext, identities, resolvedRequest }
}

/** Reads catalog evidence twice and rejects changes in the requested scope. */
async function readCatalogEvidence(
  executor: CatalogExecutor,
  queries: ReturnType<typeof createCatalogQueries>,
  scopeNamespaces: readonly (readonly CanonicalNamespaceSegment[])[],
  relationRequested: (identity: CanonicalRelationIdentity) => boolean,
  identities: CanonicalRelationIdentityModule,
) {
  const rows = await readRawCatalogEvidence(executor, queries)
  await verifyCatalogObservations({
    executor,
    queries,
    rows,
    identities,
    scopeNamespaces,
    relationRequested,
  })

  await assertRelationIdentityUnchanged(
    executor,
    queries.relationQuery,
    rows.relationRows,
    identities,
    relationRequested,
  )

  return rows
}

/**
 * Rejects changes in requested namespaces and relation-member evidence between reads.
 *
 * @param input - Catalog observation verification inputs and shared accumulators.
 */
async function verifyCatalogObservations(input: CatalogObservationVerification) {
  const { executor, queries, rows, identities, scopeNamespaces, relationRequested } =
    input

  /** Filters and orders requested namespace observations for consistency comparison. */
  const namespaceObservations = (rows: unknown[], query: string) =>
    filterNamespaceObservations(rows, query, identities, scopeNamespaces)

  /** Filters and orders requested relation observations for consistency comparison. */
  const relationObservations = (rows: unknown[], query: string) =>
    filterRelationObservations(rows, query, identities, relationRequested)

  const checks: [
    string,
    unknown[],
    ReturnType<typeof createCatalogQueries>['namespaceQuery'],
    (rows: unknown[], query: string) => unknown[],
  ][] = [
    ['namespace', rows.namespaceRows, queries.namespaceQuery, namespaceObservations],
    ['column', rows.columnRows, queries.columnQuery, relationObservations],
    ['constraint', rows.constraintRows, queries.constraintQuery, relationObservations],
    ['index', rows.indexRows, queries.indexQuery, relationObservations],
    ['opaque object', rows.opaqueRows, queries.opaqueQuery, relationObservations],
    [
      'name reservation',
      rows.reservationRows,
      queries.reservationQuery,
      namespaceObservations,
    ],
  ]

  for (const [name, initial, query, filter] of checks) {
    assertObservationUnchanged(
      name,
      filter(initial, name),
      filter(await executor.execute(query), name),
    )
  }
}

/** Builds ordered namespaces and relations from decoded catalog evidence. */
function buildCatalogNamespaces(
  namespaceRows: unknown[],
  relationRows: unknown[],
  relationRegistry: ReturnType<typeof createRelationRegistry>,
  scopeNamespaces: readonly (readonly CanonicalNamespaceSegment[])[],
  resolvedRequest: ResolvedCatalogRequest,
  identities: CanonicalRelationIdentityModule,
): CatalogNamespace[] {
  const namespaces: CatalogNamespace[] = decodeCatalogNamespaces(
    namespaceRows,
    identities,
    scopeNamespaces,
    resolvedRequest,
  )

  const relationEntries: CatalogRelation[] = buildCatalogRelations(
    relationRows,
    identities,
    relationRegistry,
  )

  for (const relation of relationEntries) {
    const namespace = namespaces.find((candidate) =>
      sameNamespace(candidate.identity, relation.identity.namespace),
    )

    if (!namespace) {
      throw new MigrationError({
        message: `PostgreSQL catalog changed during introspection: relation ${identities.format(relation.identity)} references a missing namespace`,
        stage: 'introspection',
        outcome: 'unchanged',
        retryable: true,
      })
    }

    ;(namespace.relations.items as CatalogRelation[]).push(relation)
  }

  namespaces.sort((left, right) => compareNamespaces(left.identity, right.identity))

  return namespaces
}

/**
 * Builds namespace facts and coverage from validated native rows.
 *
 * @param namespaceRows - Native namespace observations before catalog assembly.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param scopeNamespaces - Requested canonical namespaces covered by catalog queries.
 * @param resolvedRequest - Requested scope after canonical identity and namespace
 *   resolution.
 *
 * @returns Namespace facts and coverage from validated native rows.
 */
function decodeCatalogNamespaces(
  namespaceRows: unknown[],
  identities: CanonicalRelationIdentityModule,
  scopeNamespaces: readonly (readonly CanonicalNamespaceSegment[])[],
  resolvedRequest: CatalogSnapshot['request'],
) {
  const namespaces: CatalogNamespace[] = []

  for (let index = 0; index < namespaceRows.length; index++) {
    const row = rowAt(namespaceRows[index], 'namespace', index)
    const identity = identities.resolveNamespace([
      { role: 'schema', spelling: stringAt(row, 'schema', 'namespace', index) },
    ])

    if (!scopeNamespaces.some((namespace) => sameNamespace(namespace, identity))) continue

    if (namespaces.some((namespace) => sameNamespace(namespace.identity, identity)))
      throw new InvariantError('Duplicate PostgreSQL namespace row')

    namespaces.push({
      identity,
      owner: present(stringAt(row, 'owner', 'namespace', index)),
      relations: {
        items: [],
        coverage: resolvedRequest.completeNamespaces.some((namespace) =>
          sameNamespace(namespace, identity),
        )
          ? complete
          : {
              state: 'partial',
              remainder: {
                state: 'unmanaged',
                reason: 'Relations outside the requested catalog scope are unmanaged',
              },
            },
      },
    })
  }

  return namespaces
}

/**
 * Orders decoded relations by canonical identity before namespace assembly.
 *
 * @param relationRows - Native relation observations before catalog assembly.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param relationRegistry - Decoded relations indexed by canonical identity.
 *
 * @returns Decoded relations by canonical identity before namespace assembly.
 */
function buildCatalogRelations(
  relationRows: unknown[],
  identities: CanonicalRelationIdentityModule,
  relationRegistry: CanonicalRelationRegistry<MutableRelation>,
) {
  const relationEntries: CatalogRelation[] = []

  for (let index = 0; index < relationRows.length; index++) {
    const row = rowAt(relationRows[index], 'relation', index)
    const identity = identities.resolve(
      relationInput(
        stringAt(row, 'schema', 'relation', index),
        stringAt(row, 'name', 'relation', index),
      ),
    )

    const entry = relationRegistry.get(identity)

    if (!entry) continue

    let table: CatalogTable | undefined

    if (entry.table) table = orderedCatalogTable(entry.table)

    relationEntries.push({
      ...entry.relation,
      table: table === undefined ? absent : present(table),
    })
  }

  relationEntries.sort((left, right) => identities.compare(left.identity, right.identity))
  return relationEntries
}

/** Collects ordered physical names in the requested namespaces. */
function catalogNameReservations(
  reservationRows: unknown[],
  scopeNamespaces: readonly (readonly CanonicalNamespaceSegment[])[],
  identities: CanonicalRelationIdentityModule,
): CatalogNameReservation[] {
  const nameReservations: CatalogNameReservation[] = []

  for (let index = 0; index < reservationRows.length; index++) {
    const row = rowAt(reservationRows[index], 'name reservation', index)
    const namespace = identities.resolveNamespace([
      {
        role: 'schema',
        spelling: stringAt(row, 'schema', 'name reservation', index),
      },
    ])

    if (!scopeNamespaces.some((candidate) => sameNamespace(candidate, namespace)))
      continue

    nameReservations.push({
      namespace,
      name: stringAt(row, 'object_name', 'name reservation', index),
    })
  }

  nameReservations.sort(
    (left, right) =>
      compareNamespaces(left.namespace, right.namespace) ||
      compareCodeUnits(left.name, right.name),
  )

  return nameReservations
}

/** Reports unavailable PostgreSQL catalog capabilities for old server versions. */
function versionLimitedCatalog(
  context: Awaited<ReturnType<typeof readCatalogContext>>,
  diagnostics: CatalogDiagnostic[],
): CatalogSnapshot {
  const { version, namespaceContext, resolvedRequest } = context
  const versionEvidence = {
    state: 'unavailable' as const,
    cause: 'version' as const,
    actual: version,
    requires: '120000',
  }

  diagnostics.push({
    code: 'catalog.capability.version',
    message: `PostgreSQL catalog introspection requires version 120000; observed ${version}`,
  })

  return {
    source: { dialect: 'postgresql', version },
    request: resolvedRequest,
    capabilities: {
      namespaces: versionEvidence,
      relationOwner: versionEvidence,
      identity: versionEvidence,
      richObjects: versionEvidence,
    },
    namespaceContext,
    namespaces: { items: [], coverage: versionEvidence },
    nameReservations: { items: [], coverage: versionEvidence },
    constraintNameReservations: { items: [], coverage: versionEvidence },
    diagnostics,
  }
}

/**
 * Strictly observes the exact migration ownership scope on one PostgreSQL session.
 *
 * @example
 *   const snapshot = await postgresCatalog.introspectCatalog(executor, request)
 *
 * @param executor - Session-bound catalog query executor.
 * @param request - Catalog ownership scope to observe.
 */
async function introspectPostgresCatalog(
  executor: CatalogExecutor,
  request: CatalogRequest,
): Promise<CatalogSnapshot> {
  const { version, versionNumber, namespaceContext, identities, resolvedRequest } =
    await readCatalogContext(executor, request)

  const { scopeSchemas, scopeNamespaces, relationRequested } = resolveCatalogScope(
    resolvedRequest,
    identities,
  )

  const diagnostics: CatalogDiagnostic[] = []

  if (versionNumber < 120000) {
    return versionLimitedCatalog(
      { version, versionNumber, namespaceContext, identities, resolvedRequest },
      diagnostics,
    )
  }

  const rows = await readCatalogEvidence(
    executor,
    createCatalogQueries(scopeSchemas),
    scopeNamespaces,
    relationRequested,
    identities,
  )

  const { namespaces, nameReservations, constraintReservations } =
    assemblePostgresCatalog(
      rows,
      { scopeNamespaces, relationRequested },
      { resolvedRequest, identities },
    )

  const snapshot = createPostgresSnapshot(
    { version, namespaceContext, resolvedRequest },
    { namespaces, nameReservations, constraintReservations },
    diagnostics,
  )

  return request.observeRenameDependencies
    ? observePostgresRenameDependencies(executor, snapshot, identities)
    : snapshot
}

/** Observes all inbound sources without broadening migration ownership. */
async function observePostgresRenameDependencies(
  executor: CatalogExecutor,
  snapshot: CatalogSnapshot,
  identities: CanonicalRelationIdentityModule,
): Promise<CatalogSnapshot> {
  const inboundQuery = renameInboundQuery(snapshot)
  const inbound = await executor.execute(inboundQuery)
  const sources = inbound.map((row, index) => renameDependencyInput(row, index))
  const targets = renameObservedTargets(snapshot)

  const dependency = await introspectPostgresCatalog(executor, {
    relations: [...targets, ...sources].map((relation) => ({
      relation,
      shape: 'additive',
    })),
    absentRelations: [],
    completeNamespaces: [],
  })

  const unsafeIdentities = await unsafeRenameRelations(executor, identities)

  assertObservationUnchanged(
    'rename inbound dependencies',
    inbound,
    await executor.execute(inboundQuery),
  )

  return {
    ...snapshot,
    renameDependencies: {
      items: dependency.namespaces.items
        .flatMap((namespace) => namespace.relations.items)
        .map((relation) =>
          unsafeIdentities.some((identity) =>
            identities.equals(identity, relation.identity),
          )
            ? { ...relation, management: 'unmanaged' as const }
            : relation,
        ),
      coverage:
        dependency.namespaces.coverage.state === 'complete'
          ? complete
          : {
              state: 'unknown',
              reason: 'Incomplete PostgreSQL rename dependency coverage',
            },
    },
  }
}

function renameObservedTargets(snapshot: CatalogSnapshot) {
  return snapshot.request.relations.map(({ identity }) => ({
    namespace: identity.namespace.map((segment) => ({
      role: segment.role,
      spelling: segment.identifier.spelling,
    })),
    relation: identity.relation.spelling,
  }))
}

/** One native inventory statement covers inbound constraints from every namespace. */
function renameInboundQuery(snapshot: CatalogSnapshot) {
  const targets = snapshot.request.relations.map(({ identity }) => ({
    schema: identity.namespace.find((segment) => segment.role === 'schema')!.identifier
      .spelling,
    name: identity.relation.spelling,
  }))

  return {
    sql: `select con.oid::text as constraint_id, c.oid::text as relation_id,
       n.nspname as schema, c.relname as name
      from pg_constraint con join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_class target on target.oid = con.confrelid
      join pg_namespace target_ns on target_ns.oid = target.relnamespace
      where con.contype = 'f' and exists (
        select 1 from jsonb_to_recordset($1::jsonb) as requested(schema text, name text)
        where requested.schema = target_ns.nspname and requested.name = target.relname)
      order by n.nspname, c.relname, con.oid`,
    params: [JSON.stringify(targets)],
  }
}

function renameDependencyInput(value: unknown, index: number) {
  const row = rowAt(value, 'rename dependency', index)
  const schema = stringAt(row, 'schema', 'rename dependency', index)

  if (schema.startsWith('pg_') || schema === 'information_schema') {
    throw new MigrationError({
      message: 'Unsupported PostgreSQL inbound dependency namespace',
    })
  }

  return relationInput(schema, stringAt(row, 'name', 'rename dependency', index))
}

/** Tracks native view dependencies and inheritance whose behavior is not supported. */
async function unsafeRenameRelations(
  executor: CatalogExecutor,
  identities: CanonicalRelationIdentityModule,
): Promise<CanonicalRelationIdentity[]> {
  const unsafe = await executor.execute({
    sql: `select n.nspname as schema, c.relname as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where exists (select 1 from pg_inherits i where i.inhrelid = c.oid or i.inhparent = c.oid)
        or exists (select 1 from pg_depend d join pg_rewrite r on r.oid = d.objid
          where d.refobjid = c.oid and d.classid = 'pg_rewrite'::regclass and r.ev_class <> c.oid)`,
    params: [],
  })

  return unsafe.map((row, index) =>
    identities.resolve(
      relationInput(
        stringAt(
          rowAt(row, 'rename dependency', index),
          'schema',
          'rename dependency',
          index,
        ),
        stringAt(
          rowAt(row, 'rename dependency', index),
          'name',
          'rename dependency',
          index,
        ),
      ),
    ),
  )
}

/**
 * Resolves requested namespaces and binds relation membership checks.
 *
 * @param resolvedRequest - Requested scope after canonical identity and namespace
 *   resolution.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns Requested namespaces and binds relation membership checks.
 */
function resolveCatalogScope(
  resolvedRequest: ResolvedCatalogRequest,
  identities: CanonicalRelationIdentityModule,
) {
  const scopeNamespaces = requestedNamespaces(resolvedRequest)
  const scopeSchemas = scopeNamespaces.map((namespace) => {
    const segment = namespace.find(({ role }) => role === 'schema')

    if (!segment) {
      throw new InvariantError(
        'PostgreSQL introspection scope is missing a schema namespace',
      )
    }

    return segment.identifier.spelling
  })

  const requestedRelations = requestedRelationRegistry(resolvedRequest, identities)

  /**
   * Tests whether a relation belongs to the requested ownership scope.
   *
   * @param identity - Canonical relation identity.
   */
  const relationRequested = (identity: CanonicalRelationIdentity) =>
    requestedRelations.has(identity) ||
    resolvedRequest.completeNamespaces.some((namespace) =>
      sameNamespace(namespace, identity.namespace),
    )

  return { scopeSchemas, scopeNamespaces, relationRequested }
}

/**
 * Attaches native columns, indexes, constraints, and opaque objects to registered
 * relations.
 *
 * @param input - Catalog relation decoding inputs and shared accumulators.
 *
 * @returns Relations with decoded columns, keys, indexes, and opaque native evidence
 *   attached.
 */
function decodeCatalogRelations(input: CatalogRelationDecoding) {
  const {
    relationRows,
    relationRequested,
    identities,
    columnRows,
    constraintRows,
    indexRows,
    opaqueRows,
  } = input

  const relationRegistry = createRelationRegistry(
    relationRows,
    relationRequested,
    identities,
  )

  /** Requires a decoded table for a requested catalog member row. */
  const requireTable = (row: Row, query: string, index: number) =>
    resolveRequestedTable(
      row,
      query,
      index,
      identities,
      relationRequested,
      relationRegistry,
    )

  appendColumns(columnRows, requireTable, identities)

  const constraintReservations: CatalogConstraintNameReservation[] = []
  appendConstraints(constraintRows, requireTable, identities, constraintReservations)

  appendIndexes(indexRows, requireTable)
  appendOpaqueObjects(opaqueRows, requireTable)
  return { relationRegistry, constraintReservations }
}

/**
 * Rejects inconsistent native identity or generated-column evidence.
 *
 * @param isIdentity - Native flag indicating identity generation.
 * @param identityGeneration - Native identity mode that must agree with the identity
 *   flag.
 * @param generated - Native generated-column classification.
 * @param generationExpression - Native expression associated with a generated column.
 * @param index - Zero-based row, column, or graph position used for ordering and
 *   diagnostics.
 */
function assertColumnGeneration(
  isIdentity: boolean,
  identityGeneration: string | null,
  generated: string,
  generationExpression: string | null,
  index: number,
): void {
  if (
    isIdentity &&
    identityGeneration !== 'ALWAYS' &&
    identityGeneration !== 'BY DEFAULT'
  ) {
    throw new InvariantError(
      `Malformed PostgreSQL column row ${index}: identity_generation is invalid`,
    )
  }

  if (generated !== 'NEVER' && generated !== 'ALWAYS') {
    throw new InvariantError(
      `Malformed PostgreSQL column row ${index}: is_generated is invalid`,
    )
  }

  if (generated === 'ALWAYS' && generationExpression === null) {
    throw new InvariantError(
      `Malformed PostgreSQL column row ${index}: generated column is missing its expression`,
    )
  }

  if (isIdentity && generated === 'ALWAYS') {
    throw new InvariantError(
      `Malformed PostgreSQL column row ${index}: column cannot be identity and computed`,
    )
  }
}

type CatalogObservationVerification = {
  executor: CatalogExecutor
  queries: ReturnType<typeof createCatalogQueries>
  rows: PostgresCatalogEvidence
  identities: CanonicalRelationIdentityModule
  scopeNamespaces: readonly (readonly CanonicalNamespaceSegment[])[]
  relationRequested: (identity: CanonicalRelationIdentity) => boolean
}

type CatalogRelationDecoding = {
  relationRows: unknown[]
  relationRequested: (identity: CanonicalRelationIdentity) => boolean
  identities: CanonicalRelationIdentityModule
  columnRows: unknown[]
  constraintRows: unknown[]
  indexRows: unknown[]
  opaqueRows: unknown[]
}

const POSTGRES_NAMESPACE_CATALOG_SQL = `
      -- catalog:namespace
      select n.nspname as schema, pg_get_userbyid(n.nspowner) as owner
      from pg_namespace n
      where n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname = any($1::text[])
      order by n.nspname
    `

const POSTGRES_RELATION_CATALOG_SQL = `
      select c.oid::text as object_id,
             n.nspname as schema, c.relname as name, c.relkind as relation_kind,
             c.relpersistence as persistence, pg_get_userbyid(c.relowner) as owner,
             case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid, true) else null end as native_definition,
             to_jsonb(coalesce(c.reloptions, '{}'::text[])) as options,
             pg_get_partkeydef(c.oid) as partition_key,
             c.relrowsecurity as row_level_security,
             c.relforcerowsecurity as force_row_level_security,
             c.relreplident as replica_identity,
             relation_am.amname as access_method,
             tablespace.spcname as tablespace,
             c.relispartition as is_partition,
             pg_get_expr(c.relpartbound, c.oid) as partition_bound
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_am relation_am on relation_am.oid = c.relam
      left join pg_tablespace tablespace on tablespace.oid = c.reltablespace
      where c.relkind in ('r', 'p', 'v', 'm', 'f')
        and n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname = any($1::text[])
      order by n.nspname, c.relname
    `

const POSTGRES_COLUMN_CATALOG_SQL = `
      -- catalog:column
      select n.nspname as schema, c.relname as table_name,
             a.attname as column_name, a.attnum as ordinal_position,
             format_type(a.atttypid, a.atttypmod) as formatted_type,
             t.typname as data_type, tn.nspname as udt_schema, t.typname as udt_name,
             not (tn.nspname = 'pg_catalog' and t.typtype = 'b') as is_user_defined,
             null as character_maximum_length, null as numeric_precision,
             null as numeric_scale,
             case when a.attnotnull then 'NO' else 'YES' end as is_nullable,
             case when a.attgenerated = '' then pg_get_expr(d.adbin, d.adrelid) else null end as column_default,
             case when a.attidentity = '' then 'NO' else 'YES' end as is_identity,
             case a.attidentity when 'a' then 'ALWAYS' when 'd' then 'BY DEFAULT' else null end as identity_generation,
             case when a.attgenerated = '' then 'NEVER' else 'ALWAYS' end as is_generated,
             case when a.attgenerated <> '' then pg_get_expr(d.adbin, d.adrelid) else null end as generation_expression
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_type t on t.oid = a.atttypid
      join pg_namespace tn on tn.oid = t.typnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
        and n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname = any($1::text[])
      order by n.nspname, c.relname, a.attnum
    `

const POSTGRES_RESERVATION_CATALOG_SQL = `
      select n.nspname as schema, c.relname as object_name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname = any($1::text[])
      order by n.nspname, c.relname
    `

type PostgresCatalogEvidence = Record<
  | 'namespaceRows'
  | 'relationRows'
  | 'columnRows'
  | 'constraintRows'
  | 'indexRows'
  | 'opaqueRows'
  | 'reservationRows',
  unknown[]
>

/**
 * Reads native catalog queries in their required observation order.
 *
 * @param executor - Executor that owns the physical session used for SQL calls.
 * @param queries - Native catalog queries or recorded executor calls in observation
 *   order.
 *
 * @returns Native catalog queries in their required observation order.
 */
async function readRawCatalogEvidence(
  executor: CatalogExecutor,
  queries: ReturnType<typeof createCatalogQueries>,
): Promise<PostgresCatalogEvidence> {
  const {
    namespaceQuery,
    relationQuery,
    columnQuery,
    constraintQuery,
    indexQuery,
    opaqueQuery,
    reservationQuery,
  } = queries

  const namespaceRows = await executor.execute(namespaceQuery)
  const relationRows = await executor.execute(relationQuery)
  const columnRows = await executor.execute(columnQuery)
  const constraintRows = await executor.execute(constraintQuery)
  const indexRows = await executor.execute(indexQuery)
  const opaqueRows = await executor.execute(opaqueQuery)
  const reservationRows = await executor.execute(reservationQuery)
  return {
    namespaceRows,
    relationRows,
    columnRows,
    constraintRows,
    indexRows,
    opaqueRows,
    reservationRows,
  }
}

/**
 * Rechecks requested relation identities and object IDs for catalog races.
 *
 * @param executor - Executor that owns the physical session used for SQL calls.
 * @param relationQuery - Recorded relation query used to verify scoped native access.
 * @param relationRows - Native relation observations before catalog assembly.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param relationRequested - Predicate that identifies relation rows within the requested
 *   ownership scope.
 */
async function assertRelationIdentityUnchanged(
  executor: CatalogExecutor,
  relationQuery: ReturnType<typeof createCatalogQueries>['relationQuery'],
  relationRows: unknown[],
  identities: CanonicalRelationIdentityModule,
  relationRequested: (identity: CanonicalRelationIdentity) => boolean,
): Promise<void> {
  const finalRelationRows = await executor.execute(relationQuery)

  /**
   * Builds stable requested-relation identity and object-ID fingerprints.
   *
   * @param rows - Raw relation rows.
   */
  const relationFingerprint = (rows: unknown[]) =>
    rows
      .flatMap((value, index) => {
        const row = rowAt(value, 'relation consistency', index)
        const identity = identities.resolve(
          relationInput(
            stringAt(row, 'schema', 'relation consistency', index),
            stringAt(row, 'name', 'relation consistency', index),
          ),
        )

        return relationRequested(identity)
          ? [
              `${identities.format(identity)}\0${stringAt(row, 'object_id', 'relation consistency', index)}`,
            ]
          : []
      })
      .sort(compareCodeUnits)

  if (
    JSON.stringify(relationFingerprint(relationRows)) !==
    JSON.stringify(relationFingerprint(finalRelationRows))
  ) {
    throw new MigrationError({
      message:
        'PostgreSQL catalog changed during introspection: requested relations were replaced, created, or removed',
      stage: 'introspection',
      outcome: 'unchanged',
      retryable: true,
    })
  }
}

/**
 * Keeps requested namespace observations in deterministic comparison order.
 *
 * @param rows - Ordered native observations or result rows to process.
 * @param query - Native query label used to identify malformed catalog evidence.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param scopeNamespaces - Requested canonical namespaces covered by catalog queries.
 *
 * @returns Requested namespace observations in deterministic comparison order.
 */
function filterNamespaceObservations(
  rows: unknown[],
  query: string,
  identities: CanonicalRelationIdentityModule,
  scopeNamespaces: readonly (readonly CanonicalNamespaceSegment[])[],
): unknown[] {
  return rows.filter((value, index) => {
    const row = rowAt(value, `${query} consistency`, index)
    const namespace = identities.resolveNamespace([
      {
        role: 'schema',
        spelling: stringAt(row, 'schema', `${query} consistency`, index),
      },
    ])

    return scopeNamespaces.some((candidate) => sameNamespace(candidate, namespace))
  })
}

/**
 * Keeps requested relation observations in deterministic comparison order.
 *
 * @param rows - Ordered native observations or result rows to process.
 * @param query - Native query label used to identify malformed catalog evidence.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param relationRequested - Predicate that identifies relation rows within the requested
 *   ownership scope.
 *
 * @returns Requested relation observations in deterministic comparison order.
 */
function filterRelationObservations(
  rows: unknown[],
  query: string,
  identities: CanonicalRelationIdentityModule,
  relationRequested: (identity: CanonicalRelationIdentity) => boolean,
): unknown[] {
  return rows.filter((value, index) => {
    const row = rowAt(value, `${query} consistency`, index)
    const identity = identities.resolve(
      relationInput(
        stringAt(row, 'schema', `${query} consistency`, index),
        stringAt(row, 'table_name', `${query} consistency`, index),
      ),
    )

    return relationRequested(identity)
  })
}

/**
 * Copies and canonically orders a relation's decoded member evidence.
 *
 * @param table - Table metadata or evidence used to resolve its members.
 *
 * @returns And canonically orders a relation's decoded member evidence.
 */
function orderedCatalogTable(table: NonNullable<MutableRelation['table']>): CatalogTable {
  /**
   * Compares catalog objects by their required physical names.
   *
   * @param left - Left catalog object.
   * @param right - Right catalog object.
   */
  const byName = <T extends { name: CatalogFact<string> }>(left: T, right: T) =>
    compareCodeUnits(factName(left.name), factName(right.name))

  return {
    columns: {
      items: table.columns.sort(
        (left, right) =>
          left.position - right.position || compareCodeUnits(left.name, right.name),
      ),
      coverage: complete,
    },
    primaryKey: table.primaryKey,
    uniqueConstraints: {
      items: table.uniqueConstraints.sort(byName),
      coverage: complete,
    },
    foreignKeys: {
      items: table.foreignKeys.sort(byName),
      coverage: complete,
    },
    indexes: { items: table.indexes.sort(byName), coverage: complete },
    options: {
      items: table.options.sort(
        (left, right) =>
          compareCodeUnits(left.name, right.name) ||
          compareCodeUnits(left.value, right.value),
      ),
      coverage: complete,
    },
    opaqueObjects: {
      items: table.opaqueObjects.sort(byName),
      coverage: complete,
    },
  }
}

/**
 * Builds physical type evidence from validated PostgreSQL column fields.
 *
 * @param row - Current native catalog row, insert row, or result object.
 * @param index - Zero-based row, column, or graph position used for ordering and
 *   diagnostics.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param nativeType - Native physical type spelling validated from PostgreSQL catalog
 *   evidence.
 *
 * @returns Physical type evidence from validated PostgreSQL column fields.
 */
function decodePostgresColumnType(
  row: Row,
  index: number,
  identities: CanonicalRelationIdentityModule,
  nativeType: string,
): CatalogColumn['dataType'] {
  return present({
    native: nativeType,
    comparisonKey: normalizePostgresDataType(nativeType),
    family: normalizePostgresDataType(nativeType).replace(/\(.*/, ''),
    parameters: [
      row.character_maximum_length,
      row.numeric_precision,
      row.numeric_scale,
    ].flatMap((value) => {
      const number = toNumberOrNull(value)
      return number === null ? [] : [number]
    }),
    userDefined: booleanAt(row, 'is_user_defined', 'column', index)
      ? present(
          identities.resolve(
            relationInput(
              stringAt(row, 'udt_schema', 'column', index),
              stringAt(row, 'udt_name', 'column', index),
            ),
          ),
        )
      : absent,
  })
}

/**
 * Decodes one PostgreSQL column's type, default, nullability, and generation evidence.
 *
 * @param row - Current native catalog row, insert row, or result object.
 * @param index - Zero-based row, column, or graph position used for ordering and
 *   diagnostics.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns One PostgreSQL column's type, default, nullability, and generation evidence.
 */
function decodePostgresColumn(
  row: Row,
  index: number,
  identities: CanonicalRelationIdentityModule,
): CatalogColumn {
  const nativeType = formatPostgresCatalogDataType(row, 'column', index)
  const columnDefault = nullableStringAt(row, 'column_default', 'column', index)
  const isIdentity = booleanAt(row, 'is_identity', 'column', index)
  const identityGeneration = nullableStringAt(row, 'identity_generation', 'column', index)
  const generated = stringAt(row, 'is_generated', 'column', index)
  const generationExpression = nullableStringAt(
    row,
    'generation_expression',
    'column',
    index,
  )

  assertColumnGeneration(
    isIdentity,
    identityGeneration,
    generated,
    generationExpression,
    index,
  )

  return {
    name: stringAt(row, 'column_name', 'column', index),
    position: positiveIntegerAt(row, 'ordinal_position', 'column', index),
    dataType: decodePostgresColumnType(row, index, identities, nativeType),
    nullable: present(booleanAt(row, 'is_nullable', 'column', index)),
    default:
      columnDefault === null
        ? absent
        : present({
            kind: 'nativeExpression',
            native: columnDefault,
            comparisonKey: present(normalizePostgresDefaultExpression(columnDefault)),
          }),
    generation: columnGeneration(
      isIdentity,
      identityGeneration,
      generated,
      generationExpression,
    ),
    nativeDefinition: present(nativeType),
  }
}

/**
 * Resolves a requested row to its mutable table entry.
 *
 * @param row - Catalog row referencing a table.
 * @param query - Query name for diagnostics.
 * @param index - Row index for diagnostics.
 */
function resolveRequestedTable(
  row: Row,
  query: string,
  index: number,
  identities: CanonicalRelationIdentityModule,
  relationRequested: (identity: CanonicalRelationIdentity) => boolean,
  relationRegistry: CanonicalRelationRegistry<MutableRelation>,
) {
  const identity = identities.resolve(
    relationInput(
      stringAt(row, 'schema', query, index),
      stringAt(row, 'table_name', query, index),
    ),
  )

  if (!relationRequested(identity)) return undefined

  const entry = relationRegistry.get(identity)

  if (!entry) {
    throw new MigrationError({
      message: `PostgreSQL catalog changed during introspection: ${query} row references missing table ${identities.format(identity)}`,
      stage: 'introspection',
      outcome: 'unchanged',
      retryable: true,
    })
  }

  if (!entry.table) return undefined

  return { identity, table: entry.table }
}

/**
 * Builds requested namespaces and physical-name reservations from decoded catalog rows.
 *
 * @param rows - Ordered native observations or result rows to process.
 * @param scope - Requested catalog or coordination scope for this scenario.
 * @param context - Resolved namespace, client, or session dependencies used by this
 *   operation.
 *
 * @returns Requested namespaces and physical-name reservations from decoded catalog rows.
 */
function assemblePostgresCatalog(
  rows: PostgresCatalogEvidence,
  scope: Pick<
    ReturnType<typeof resolveCatalogScope>,
    'scopeNamespaces' | 'relationRequested'
  >,
  context: Pick<
    Awaited<ReturnType<typeof readCatalogContext>>,
    'resolvedRequest' | 'identities'
  >,
) {
  const { namespaceRows, relationRows, reservationRows } = rows
  const { scopeNamespaces, relationRequested } = scope
  const { resolvedRequest, identities } = context
  const { relationRegistry, constraintReservations } = decodeCatalogRelations({
    ...rows,
    relationRequested,
    identities,
  })

  const namespaces = buildCatalogNamespaces(
    namespaceRows,
    relationRows,
    relationRegistry,
    scopeNamespaces,
    resolvedRequest,
    identities,
  )

  const nameReservations = catalogNameReservations(
    reservationRows,
    scopeNamespaces,
    identities,
  )

  constraintReservations.sort(
    (left, right) =>
      identities.compare(left.relation, right.relation) ||
      compareCodeUnits(left.name, right.name),
  )

  return { namespaces, nameReservations, constraintReservations }
}

/**
 * Combines the resolved request, catalog objects, capabilities, and diagnostics into a
 * snapshot.
 *
 * @param context - Resolved namespace, client, or session dependencies used by this
 *   operation.
 * @param objects - Native objects used to check catalog coverage and reservations.
 * @param diagnostics - Mutable catalog diagnostics preserving unsupported or unmanaged
 *   evidence.
 *
 * @returns A snapshot retaining resolved scope, catalog capabilities, and diagnostics.
 */
function createPostgresSnapshot(
  context: Pick<
    Awaited<ReturnType<typeof readCatalogContext>>,
    'version' | 'namespaceContext' | 'resolvedRequest'
  >,
  objects: ReturnType<typeof assemblePostgresCatalog>,
  diagnostics: CatalogDiagnostic[],
): CatalogSnapshot {
  const { version, namespaceContext, resolvedRequest } = context
  const { namespaces, nameReservations, constraintReservations } = objects
  return {
    source: { dialect: 'postgresql', version },
    request: resolvedRequest,
    capabilities: {
      namespaces: { state: 'supported', fidelity: 'native' },
      relationOwner: { state: 'supported', fidelity: 'native' },
      identity: { state: 'supported', fidelity: 'native' },
      richObjects: { state: 'supported', fidelity: 'opaque' },
    },
    namespaceContext,
    namespaces: { items: namespaces, coverage: complete },
    nameReservations: { items: nameReservations, coverage: complete },
    constraintNameReservations: { items: constraintReservations, coverage: complete },
    diagnostics: diagnostics.sort(
      (left, right) =>
        compareCodeUnits(left.code, right.code) ||
        compareCodeUnits(left.message, right.message),
    ),
  }
}

/** Decodes a foreign key's ordered target columns, actions, and native semantics. */
function decodePostgresForeignKey(
  row: Row,
  index: number,
  identities: CanonicalRelationIdentityModule,
  key: CatalogKeyConstraint,
): CatalogForeignKey {
  return {
    ...key,
    referencedRelation: identities.resolve(
      relationInput(
        stringAt(row, 'referenced_schema', 'constraint', index),
        stringAt(row, 'referenced_table', 'constraint', index),
      ),
    ),
    referencedColumns: stringArrayAt(row, 'referenced_columns', 'constraint', index),
    onDelete: referentialAction(
      stringAt(row, 'on_delete', 'constraint', index),
      'constraint',
      index,
    ),
    onUpdate: referentialAction(
      stringAt(row, 'on_update', 'constraint', index),
      'constraint',
      index,
    ),
  }
}

/** PostgreSQL scoped catalog observation. */
export const postgresCatalog = { introspectCatalog: introspectPostgresCatalog }
