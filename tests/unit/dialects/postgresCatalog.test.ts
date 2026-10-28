import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { createMigrateBuilder } from '@/ddl/migrate'
import type { CatalogExecutor, CatalogRequest, CatalogTable } from '@/dialects'
import type { CatalogColumn, CatalogIndex, CatalogRelation } from '@/dialects/catalog'
import type { CatalogSnapshot } from '@/index'
import { column, defineTable, postgresDialect } from '@/index'
import type { Executor } from '@/query'
import { InvariantError, MigrationError } from '@/utils/error'

const shouldNormalizeCatalogRowsIntoAPublicSnapshotData2 = [
  {
    name: 'events_account_fkey',
    columns: ['account_id'],
    referencedSchema: 'public',
    referencedTable: 'accounts',
    referencedColumns: ['id'],
    onDelete: 'cascade',
    onUpdate: 'restrict',
    semanticCompleteness: 'supportedSimple',
    isValid: true,
  },
]

const fixtureColumnRowsData = {
  schema: 'public',
  table_name: 'events',
  column_name: 'id',
  ordinal_position: 1,
  data_type: 'uuid',
  udt_name: 'uuid',
  is_user_defined: false,
  character_maximum_length: null,
  numeric_precision: null,
  numeric_scale: null,
  is_nullable: 'NO',
  column_default: null,
  is_identity: 'NO',
  identity_generation: null,
  is_generated: 'NEVER',
  generation_expression: null,
}

const fixtureColumnRowsData2 = {
  schema: 'public',
  table_name: 'events',
  column_name: 'normalized_payload',
  ordinal_position: 3,
  data_type: 'text',
  udt_name: 'text',
  is_user_defined: false,
  character_maximum_length: null,
  numeric_precision: null,
  numeric_scale: null,
  is_nullable: 'YES',
  column_default: null,
  is_identity: 'NO',
  identity_generation: null,
  is_generated: 'ALWAYS',
  generation_expression: 'lower(payload)',
}

const fixtureColumnRowsData3 = {
  schema: 'public',
  table_name: 'events',
  column_name: 'status',
  ordinal_position: 4,
  formatted_type: 'public.event_status',
  data_type: 'event_status',
  udt_schema: 'public',
  udt_name: 'event_status',
  is_user_defined: true,
  character_maximum_length: null,
  numeric_precision: null,
  numeric_scale: null,
  is_nullable: 'NO',
  column_default: null,
  is_identity: 'NO',
  identity_generation: null,
  is_generated: 'NEVER',
  generation_expression: null,
}

const fixtureConstraintRowsConstraints = [
  {
    schema: 'public',
    table_name: 'events',
    constraint_name: 'events_pkey',
    constraint_type: 'p',
    columns: ['id'],
    is_valid: true,
    is_deferrable: false,
    initially_deferred: false,
    backing_index_is_valid: true,
    has_supported_backing_index_semantics: true,
    backing_index_nulls_not_distinct: false,
    native_definition: 'primary key (id)',
  },
]

const rejectsForeignKeysWithUnresolvedReferencedRelationMetadataData = [
  {
    object_id: '1',
    schema: 'public',
    name: 'events',
    relation_kind: 'r',
    persistence: 'p',
    owner: 'app',
    native_definition: null,
    options: [],
    partition_key: null,
    row_level_security: false,
    force_row_level_security: false,
    replica_identity: 'd',
    access_method: 'heap',
    tablespace: null,
    is_partition: false,
    partition_bound: null,
  },
]

const rejectsForeignKeysWithUnresolvedReferencedRelationMetadataData2 = [
  {
    schema: 'public',
    table_name: 'events',
    constraint_name: 'events_owner_fkey',
    constraint_type: 'f',
    columns: ['owner_id'],
    referenced_columns: ['id'],
    is_valid: true,
    is_deferrable: false,
    initially_deferred: false,
    match_type: 's',
    has_column_specific_delete_action: false,
    on_delete: 'no action',
    on_update: 'no action',
    native_definition: 'foreign key (owner_id) references owners(id)',
  },
]

const normalizationFixtureExecutorData = [
  {
    object_id: '1',
    schema: 'public',
    name: 'accounts',
    relation_kind: 'r',
    persistence: 'p',
    owner: 'app',
    native_definition: null,
    options: [],
    partition_key: null,
    row_level_security: false,
    force_row_level_security: false,
    replica_identity: 'd',
    access_method: 'heap',
    tablespace: null,
    is_partition: false,
    partition_bound: null,
  },
  {
    object_id: '2',
    schema: 'app',
    name: 'events',
    relation_kind: 'r',
    persistence: 'p',
    owner: 'app',
    native_definition: null,
    options: [],
    partition_key: null,
    row_level_security: false,
    force_row_level_security: false,
    replica_identity: 'd',
    access_method: 'heap',
    tablespace: null,
    is_partition: false,
    partition_bound: null,
  },
]

const normalizationFixtureExecutorData2 = [
  {
    schema: 'public',
    table_name: 'accounts',
    index_name: 'accounts_email_idx',
    is_unique: 'YES',
    columns: '{email}',
    has_supported_semantics: true,
    is_valid: true,
    nulls_not_distinct: false,
    native_definition:
      'create unique index accounts_email_idx on public.accounts (email)',
  },
  {
    schema: 'app',
    table_name: 'events',
    index_name: 'events_invalid_idx',
    is_unique: 0,
    columns: '{code}',
    has_supported_semantics: true,
    is_valid: false,
    nulls_not_distinct: false,
    native_definition: 'create index events_invalid_idx on app.events (code)',
  },
  {
    schema: 'public',
    table_name: 'accounts',
    index_name: 'accounts_email_nnd_idx',
    is_unique: true,
    columns: '{email}',
    has_supported_semantics: true,
    is_valid: true,
    nulls_not_distinct: true,
    native_definition:
      'create unique index accounts_email_nnd_idx on public.accounts (email) nulls not distinct',
  },
]

const keepsDottedSchemaAndRelationTuplesDistinctDuringIntrospectionData = [
  {
    object_id: '1',
    schema: 'a.b',
    name: 'c',
    relation_kind: 'r',
    persistence: 'p',
    owner: 'app',
    native_definition: null,
    options: [],
    partition_key: null,
    row_level_security: false,
    force_row_level_security: false,
    replica_identity: 'd',
    access_method: 'heap',
    tablespace: null,
    is_partition: false,
    partition_bound: null,
  },
  {
    object_id: '2',
    schema: 'a',
    name: 'b.c',
    relation_kind: 'r',
    persistence: 'p',
    owner: 'app',
    native_definition: null,
    options: [],
    partition_key: null,
    row_level_security: false,
    force_row_level_security: false,
    replica_identity: 'd',
    access_method: 'heap',
    tablespace: null,
    is_partition: false,
    partition_bound: null,
  },
]

const keepsDottedSchemaAndRelationTuplesDistinctDuringIntrospectionData2 = [
  {
    schema: 'a.b',
    table_name: 'c',
    column_name: 'schema_marker',
    ordinal_position: 1,
    data_type: 'text',
    udt_name: 'text',
    is_user_defined: false,
    is_nullable: 'NO',
    column_default: null,
    is_identity: 'NO',
    identity_generation: null,
    is_generated: 'NEVER',
    generation_expression: null,
  },
  {
    schema: 'a',
    table_name: 'b.c',
    column_name: 'relation_marker',
    ordinal_position: 1,
    data_type: 'text',
    udt_name: 'text',
    is_user_defined: false,
    is_nullable: 'NO',
    column_default: null,
    is_identity: 'NO',
    identity_generation: null,
    is_generated: 'NEVER',
    generation_expression: null,
  },
]

const normalizationColumnRowsData = [
  {
    schema: 'public',
    table_name: 'accounts',
    column_name: 'id',
    ordinal_position: 1,
    data_type: 'integer',
    udt_name: 'int4',
    is_user_defined: false,
    is_nullable: 'NO',
    column_default: null,
    is_identity: 'YES',
    identity_generation: 'ALWAYS',
    is_generated: 'NEVER',
    generation_expression: null,
  },
  {
    schema: 'public',
    table_name: 'accounts',
    column_name: 'email',
    ordinal_position: 2,
    data_type: 'character varying',
    udt_name: 'varchar',
    is_user_defined: false,
    character_maximum_length: '255',
    numeric_precision: null,
    numeric_scale: null,
    is_nullable: 'YES',
    column_default: "(('new'::text))",
    is_identity: 'NO',
    identity_generation: null,
    is_generated: 'NEVER',
    generation_expression: null,
  },
  {
    schema: 'app',
    table_name: 'events',
    column_name: 'code',
    ordinal_position: 1,
    data_type: 'character',
    udt_name: 'bpchar',
    is_user_defined: false,
    character_maximum_length: 8,
    numeric_precision: null,
    numeric_scale: null,
    is_nullable: 'YES',
    column_default: null,
    is_identity: 'NO',
    identity_generation: null,
    is_generated: 'NEVER',
    generation_expression: null,
  },
  {
    schema: 'app',
    table_name: 'events',
    column_name: 'amount',
    ordinal_position: 2,
    data_type: 'numeric',
    udt_name: 'numeric',
    is_user_defined: false,
    character_maximum_length: null,
    numeric_precision: '10',
    numeric_scale: '2',
    is_nullable: 'YES',
    column_default: null,
    is_identity: 'NO',
    identity_generation: null,
    is_generated: 'NEVER',
    generation_expression: null,
  },
  {
    schema: 'app',
    table_name: 'events',
    column_name: 'created_at',
    ordinal_position: 3,
    data_type: 'timestamp with time zone',
    udt_name: 'timestamptz',
    is_user_defined: false,
    character_maximum_length: null,
    numeric_precision: null,
    numeric_scale: null,
    is_nullable: 'YES',
    column_default: '(now())',
    is_identity: 'NO',
    identity_generation: null,
    is_generated: 'NEVER',
    generation_expression: null,
  },
  {
    schema: 'app',
    table_name: 'events',
    column_name: 'label',
    ordinal_position: 4,
    data_type: 'text',
    udt_name: 'text',
    is_user_defined: false,
    character_maximum_length: null,
    numeric_precision: null,
    numeric_scale: null,
    is_nullable: 'YES',
    column_default: "('a') || ('b')",
    is_identity: 'NO',
    identity_generation: null,
    is_generated: 'NEVER',
    generation_expression: null,
  },
  {
    schema: 'app',
    table_name: 'events',
    column_name: 'status',
    ordinal_position: 5,
    data_type: 'text',
    udt_name: 'text',
    is_user_defined: false,
    character_maximum_length: null,
    numeric_precision: null,
    numeric_scale: null,
    is_nullable: 'YES',
    column_default: "'hello'::text::varchar",
    is_identity: 'NO',
    identity_generation: null,
    is_generated: 'NEVER',
    generation_expression: null,
  },
]

const normalizationConstraintRowsData = [
  {
    schema: 'public',
    table_name: 'accounts',
    constraint_name: 'accounts_pkey',
    constraint_type: 'p',
    columns: '{id}',
    is_valid: true,
    is_deferrable: false,
    initially_deferred: false,
    backing_index_is_valid: true,
    has_supported_backing_index_semantics: true,
    backing_index_nulls_not_distinct: false,
    native_definition: 'primary key (id)',
  },
  {
    schema: 'public',
    table_name: 'accounts',
    constraint_name: 'accounts_email_key',
    constraint_type: 'u',
    columns: '["email"]',
    is_valid: true,
    is_deferrable: false,
    initially_deferred: false,
    backing_index_is_valid: true,
    has_supported_backing_index_semantics: true,
    backing_index_nulls_not_distinct: false,
    native_definition: 'unique (email)',
  },
  {
    schema: 'public',
    table_name: 'accounts',
    constraint_name: 'accounts_email_nnd_key',
    constraint_type: 'u',
    columns: '{email}',
    is_valid: true,
    is_deferrable: false,
    initially_deferred: false,
    backing_index_is_valid: true,
    has_supported_backing_index_semantics: true,
    backing_index_nulls_not_distinct: true,
    native_definition: 'unique nulls not distinct (email)',
  },
  {
    schema: 'public',
    table_name: 'accounts',
    constraint_name: 'accounts_email_include_key',
    constraint_type: 'u',
    columns: '{email}',
    is_valid: true,
    is_deferrable: false,
    initially_deferred: false,
    backing_index_is_valid: true,
    has_supported_backing_index_semantics: false,
    backing_index_nulls_not_distinct: false,
    native_definition: 'unique (email) include (id)',
  },
  {
    schema: 'app',
    table_name: 'events',
    constraint_name: 'events_account_fkey',
    constraint_type: 'f',
    columns: ['account_id'],
    referenced_schema: 'public',
    referenced_table: 'accounts',
    referenced_columns: '{id}',
    on_delete: 'cascade',
    on_update: 'restrict',
    is_valid: true,
    is_deferrable: false,
    initially_deferred: false,
    match_type: 's',
    has_column_specific_delete_action: false,
    native_definition: 'foreign key (account_id) references public.accounts(id)',
  },
  {
    schema: 'public',
    table_name: 'accounts',
    constraint_name: 'accounts_email_check',
    constraint_type: 'c',
    columns: '{email}',
    is_valid: true,
    is_deferrable: false,
    initially_deferred: false,
    native_definition: 'check (email is not null)',
  },
]

const shouldNormalizeCatalogRowsIntoAPublicSnapshotData = {
  name: 'accounts',
  schema: 'public',
  columns: [
    {
      name: 'id',
      dataType: 'integer',
      isNullable: false,
      hasDefault: false,
      isIdentity: true,
      defaultExpression: null,
      identityGeneration: 'always',
    },
    {
      name: 'email',
      dataType: 'varchar(255)',
      isNullable: true,
      hasDefault: true,
      isIdentity: false,
      defaultExpression: "'new'",
      identityGeneration: null,
    },
  ],
  indexes: [
    {
      name: 'accounts_email_idx',
      columns: ['email'],
      unique: true,
      semanticCompleteness: 'supportedSimple',
      isValid: true,
    },
    {
      name: 'accounts_email_nnd_idx',
      columns: ['email'],
      unique: true,
      semanticCompleteness: 'unsupported',
      isValid: true,
    },
  ],
  primaryKey: {
    name: 'accounts_pkey',
    columns: ['id'],
    semanticCompleteness: 'supportedSimple',
    isValid: true,
  },
  uniqueConstraints: [
    {
      name: 'accounts_email_include_key',
      columns: ['email'],
      semanticCompleteness: 'unsupported',
      isValid: true,
    },
    {
      name: 'accounts_email_key',
      columns: ['email'],
      semanticCompleteness: 'supportedSimple',
      isValid: true,
    },
    {
      name: 'accounts_email_nnd_key',
      columns: ['email'],
      semanticCompleteness: 'unsupported',
      isValid: true,
    },
  ],
  foreignKeys: [],
}

const request: CatalogRequest = {
  relations: [
    {
      relation: {
        namespace: [{ role: 'schema', spelling: 'public' }],
        relation: 'events',
      },
      shape: 'complete',
    },
  ],
  absentRelations: [],
  completeNamespaces: [],
}

/**
 * Builds native column observations with the selected schema variations.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure
 *   scenarios.
 *
 * @returns Native column observations with the selected schema variations.
 */
function fixtureColumnRows(options: { version?: string }) {
  return [
    structuredClone(fixtureColumnRowsData),
    structuredClone(fixtureColumnRowsData2),
    {
      schema: 'public',
      table_name: 'events',
      column_name: 'payload',
      ordinal_position: 2,
      data_type: 'text',
      udt_name: 'text',
      is_user_defined: false,
      character_maximum_length: null,
      numeric_precision: null,
      numeric_scale: null,
      is_nullable: options.version === '180001' ? 'NO' : 'YES',
      column_default: null,
      is_identity: 'NO',
      identity_generation: null,
      is_generated: 'NEVER',
      generation_expression: null,
    },
    structuredClone(fixtureColumnRowsData3),
  ]
}

/**
 * Builds native PostgreSQL index rows, including requested unsupported or malformed
 * semantics.
 *
 * @param malformedIndex - Invalid native index observation used for rejection checks.
 *
 * @returns Native PostgreSQL index rows, including requested unsupported or malformed
 *   semantics.
 */
function fixtureIndexRows(malformedIndex: boolean | undefined) {
  return [
    {
      schema: 'public',
      table_name: 'events',
      index_name: 'events_payload_idx',
      is_unique: false,
      is_valid: true,
      nulls_not_distinct: false,
      has_supported_semantics: true,
      columns: ['payload'],
      native_definition: 'create index events_payload_idx on events (payload)',
    },
    {
      schema: 'public',
      table_name: 'events',
      index_name: 'events_quoted_idx',
      is_unique: false,
      is_valid: true,
      nulls_not_distinct: false,
      has_supported_semantics: true,
      columns: '{" payload,part ","NULL"}',
      native_definition: 'create index events_quoted_idx on events ("payload,part")',
    },
    {
      schema: 'public',
      table_name: 'events',
      index_name: 'events_lower_payload_idx',
      is_unique: false,
      is_valid: true,
      nulls_not_distinct: false,
      has_supported_semantics: false,
      columns: malformedIndex ? '[invalid json]' : [],
      native_definition:
        'create index events_lower_payload_idx on events (lower(payload))',
    },
  ]
}

/**
 * Builds native PostgreSQL key and opaque constraint observations for the selected
 * server version.
 *
 * @param version - Native server-version spelling used to choose catalog capabilities.
 *
 * @returns Native PostgreSQL key and opaque constraint observations for the selected
 *   server version.
 */
function fixtureConstraintRows(version: string | undefined): unknown[] {
  const constraints: unknown[] = structuredClone(fixtureConstraintRowsConstraints)

  if (version === '180001') {
    constraints.push({
      schema: 'public',
      table_name: 'events',
      constraint_name: 'events_payload_not_null',
      constraint_type: 'n',
      is_valid: true,
      // NOT NULL rows do not need key-constraint metadata decoded.
      columns: '[invalid json]',
    })

    constraints.push({
      schema: 'public',
      table_name: 'events',
      constraint_name: 'events_status_not_null',
      constraint_type: 'n',
      columns: ['status'],
      is_valid: false,
      is_deferrable: false,
      initially_deferred: false,
      native_definition: 'not null not valid',
    })

    constraints.push({
      schema: 'public',
      table_name: 'events',
      constraint_name: 'events_payload_check',
      constraint_type: 'c',
      columns: ['payload'],
      is_valid: true,
      is_deferrable: false,
      initially_deferred: false,
      native_definition: 'check (length(payload) > 0)',
    })
  }

  return constraints
}

/**
 * Creates a catalog executor with configurable native observations and query-order
 * tracking.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure
 *   scenarios.
 *
 * @returns A catalog executor with configurable native observations and query-order
 *   tracking.
 */
function executor(options: PostgresFixtureOptions = {}): CatalogExecutor {
  /** Returns fixture rows in the configured observation order. */
  const order = <T>(rows: T[]) => (options.reverse ? rows.reverse() : rows)
  const queryState: PostgresFixtureQueryState = { relationQueries: 0, columnQueries: 0 }

  return {
    /** Executes fixture SQL with the configured native observations. */
    execute: ({ sql }) => executePostgresFixture({ sql }, options, queryState, order),
  }
}

/** Runs the public migration builder against the controlled PostgreSQL catalog rows. */
function migrationWithCatalogFixture(options: PostgresFixtureOptions) {
  const observed = executor(options)
  const session: Executor = {
    /** Returns stable advisory-lock acknowledgements around real catalog reads. */
    async execute(query) {
      if (query.sql.includes('pg_try_advisory_lock')) return [{ locked: true }]
      if (query.sql.includes('pg_advisory_unlock')) return [{ unlocked: true }]

      return observed.execute(query)
    },
    /** Acknowledges transaction statements without changing the controlled catalog. */
    async run() {},
  }

  const Events = defineTable(
    'events',
    { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
    { primaryKey: 'id' },
  )

  return createMigrateBuilder({
    schemas: [Events],
    migration: postgresDialect.migration,
    runOperation: async (operation) =>
      operation(
        session,
        'test',
        () => undefined,
        async () => undefined,
      ),
  })
}

/**
 * Builds catalog request evidence for schema reconciliation checks.
 *
 * @param relations - Resolved query relations or requested catalog relations.
 *
 * @returns Catalog request evidence for schema reconciliation checks.
 */
const catalogRequest = (
  ...relations: { schema: string; table: string }[]
): CatalogRequest => ({
  relations: relations.map(({ schema, table }) => ({
    relation: {
      namespace: [{ role: 'schema', spelling: schema }],
      relation: table,
    },
    shape: 'complete',
  })),
  absentRelations: [],
  completeNamespaces: [],
})

/** Checks that member queries bind only the requested PostgreSQL schemas. */
function assertScopedCatalogQueries(queries: { sql: string; params: unknown[] }[]) {
  for (const query of queries.slice(1)) {
    expect(query.sql).toContain('n.nspname = any($1::text[])')
    expect(query.params).toEqual([['public']])
  }
}

/** Checks complete relation coverage when a whole namespace is requested. */
async function assertCompleteNamespaceCoverage() {
  const completeNamespace = await postgresDialect.catalog.introspectCatalog(executor(), {
    relations: [],
    absentRelations: [],
    completeNamespaces: [[{ role: 'schema', spelling: 'public' }]],
  })

  expect(completeNamespace.namespaces.items[0]!.relations.coverage).toEqual({
    state: 'complete',
  })
}

/**
 * Checks preserved native indexes, constraints, and opaque objects outside the portable
 * model.
 *
 * @param richIndex - Native index with semantics beyond the portable index model.
 * @param table - Table metadata or evidence used to resolve its members.
 */
function assertPostgresNativeEvidence(richIndex: CatalogIndex, table: CatalogTable) {
  expect(richIndex.semantics.state).toBe('unsupported')

  expect(richIndex.nativeDefinition).toEqual({
    state: 'present',
    value: 'create index events_lower_payload_idx on events (lower(payload))',
  })

  expect(table.options.items).toContainEqual({
    name: 'fillfactor',
    value: '90',
  })

  expect(
    table.columns.items.find((column) => column.name === 'normalized_payload')
      ?.generation,
  ).toEqual({
    state: 'present',
    value: {
      kind: 'computed',
      storage: 'stored',
      expression: 'lower(payload)',
    },
  })

  expect(
    table.columns.items.find((column) => column.name === 'status')?.dataType,
  ).toMatchObject({
    state: 'present',
    value: {
      userDefined: {
        state: 'present',
        value: { relation: { spelling: 'event_status' } },
      },
    },
  })

  expect(
    table.indexes.items.find(
      (index) => index.name.state === 'present' && index.name.value.includes('quoted'),
    )?.columns,
  ).toEqual([' payload,part ', 'NULL'])
}

/**
 * Projects evidence-bearing catalog facts into the shape used by normalization
 * assertions.
 *
 * @param snapshot - Observed catalog snapshot whose evidence is checked or projected.
 *
 * @returns Evidence-bearing catalog facts into the shape used by normalization
 *   assertions.
 */
function catalogFixtureView(snapshot: CatalogSnapshot) {
  const tables = snapshot.namespaces.items.flatMap((namespace) =>
    namespace.relations.items.flatMap(catalogRelationView),
  )

  tables.sort((left, right) => {
    if (right.schema < left.schema) return -1
    if (right.schema > left.schema) return 1

    return 0
  })

  return {
    tables,
    namespaceContext: snapshot.namespaceContext,
    nameReservations: snapshot.nameReservations.items.map((reservation) => ({
      schema: reservation.namespace.find(({ role }) => role === 'schema')!.identifier
        .spelling,
      name: reservation.name,
    })),
    constraintNameReservations: snapshot.constraintNameReservations.items.map(
      (reservation) => ({
        schema: reservation.relation.namespace.find(({ role }) => role === 'schema')!
          .identifier.spelling,
        table: reservation.relation.relation.spelling,
        name: reservation.name,
      }),
    ),
  }
}

/** Builds native columns used to check catalog type and default normalization. */
function normalizationColumnRows(): unknown[] {
  return structuredClone(normalizationColumnRowsData)
}

/** Builds native constraints used to check portable and opaque catalog normalization. */
function normalizationConstraintRows(): unknown[] {
  return structuredClone(normalizationConstraintRowsData)
}

/**
 * Supplies native catalog normalization rows while recording executed SQL.
 *
 * @param executedSql - Recorded native catalog SQL in execution order.
 *
 * @returns Native catalog normalization rows while recording executed SQL.
 */
function normalizationFixtureExecutor(executedSql: string[]): Executor {
  return {
    /** Executes fixture SQL with the configured native observations. */
    async execute({ sql }) {
      executedSql.push(sql)

      if (sql.includes('current_database()')) {
        return [{ database: 'test', schema: 'public', version: '160000' }]
      }

      if (sql.includes('-- catalog:namespace')) {
        return [
          { schema: 'public', owner: 'app' },
          { schema: 'app', owner: 'app' },
        ]
      }

      if (sql.includes('as relation_kind')) {
        return structuredClone(normalizationFixtureExecutorData)
      }

      if (sql.includes('-- catalog:column')) return normalizationColumnRows()

      if (sql.includes('from pg_index i')) {
        return structuredClone(normalizationFixtureExecutorData2)
      }

      if (sql.includes('from pg_constraint con')) return normalizationConstraintRows()

      if (sql.includes('c.relname as object_name')) {
        return [
          { schema: 'public', object_name: 'accounts' },
          { schema: 'public', object_name: 'reserved_sequence' },
          { schema: 'public', object_name: 'accounts_composite' },
          { schema: 'public', object_name: 'accounts_partitioned_index' },
          { schema: 'public', object_name: 'accounts_email_nnd_idx' },
          { schema: 'public', object_name: 'accounts_email_nnd_key' },
          { schema: 'public', object_name: 'accounts_email_include_key' },
        ]
      }

      return []
    },
    /** Runs a fixture statement with configured outcomes. */
    async run() {},
  }
}

/**
 * Supplies distinct native identities whose schema or relation spellings contain dots.
 *
 * @returns Distinct native identities whose schema or relation spellings contain dots.
 */
function createDottedCatalogExecutor(): Executor {
  return {
    /** Executes fixture SQL with the configured native observations. */
    async execute({ sql }) {
      if (sql.includes('current_database()')) {
        return [{ database: 'test', schema: 'public', version: '160000' }]
      }

      if (sql.includes('-- catalog:namespace')) {
        return [
          { schema: 'a.b', owner: 'app' },
          { schema: 'a', owner: 'app' },
        ]
      }

      if (sql.includes('as relation_kind')) {
        return structuredClone(
          keepsDottedSchemaAndRelationTuplesDistinctDuringIntrospectionData,
        )
      }

      if (sql.includes('-- catalog:column')) {
        return structuredClone(
          keepsDottedSchemaAndRelationTuplesDistinctDuringIntrospectionData2,
        )
      }

      return []
    },
    /** Runs a fixture statement with configured outcomes. */
    async run() {},
  }
}

/**
 * Checks normalized columns, indexes, and keys in the portable catalog fixture view.
 *
 * @param snapshot - Observed catalog snapshot whose evidence is checked or projected.
 */
function assertNormalizedCatalogTables(snapshot: ReturnType<typeof catalogFixtureView>) {
  expect(snapshot.tables).toEqual([
    structuredClone(shouldNormalizeCatalogRowsIntoAPublicSnapshotData),
    {
      name: 'events',
      schema: 'app',
      columns: [
        expect.objectContaining({ name: 'code', dataType: 'char(8)' }),
        expect.objectContaining({ name: 'amount', dataType: 'numeric(10,2)' }),
        expect.objectContaining({
          name: 'created_at',
          dataType: 'timestamptz',
          defaultExpression: 'now()',
        }),
        expect.objectContaining({
          name: 'label',
          defaultExpression: "('a') || ('b')",
        }),
        expect.objectContaining({
          name: 'status',
          defaultExpression: "'hello'",
        }),
      ],
      indexes: [
        {
          name: 'events_invalid_idx',
          columns: ['code'],
          unique: false,
          semanticCompleteness: 'supportedSimple',
          isValid: false,
        },
      ],
      primaryKey: null,
      uniqueConstraints: [],
      foreignKeys: structuredClone(shouldNormalizeCatalogRowsIntoAPublicSnapshotData2),
    },
  ])
}

/**
 * Checks normalized namespace context and physical-name reservations.
 *
 * @param snapshot - Observed catalog snapshot whose evidence is checked or projected.
 */
function assertNormalizedCatalogReservations(
  snapshot: ReturnType<typeof catalogFixtureView>,
) {
  expect(snapshot.namespaceContext).toEqual({
    writableDefault: [
      { role: 'database', spelling: 'test' },
      { role: 'schema', spelling: 'public' },
    ],
  })

  expect(snapshot.nameReservations).toEqual(
    expect.arrayContaining([
      { schema: 'public', name: 'accounts' },
      { schema: 'public', name: 'reserved_sequence' },
      { schema: 'public', name: 'accounts_composite' },
      { schema: 'public', name: 'accounts_partitioned_index' },
      { schema: 'public', name: 'accounts_email_nnd_idx' },
      { schema: 'public', name: 'accounts_email_nnd_key' },
      { schema: 'public', name: 'accounts_email_include_key' },
    ]),
  )

  expect(snapshot.nameReservations).toHaveLength(7)

  expect(snapshot.constraintNameReservations).toEqual(
    expect.arrayContaining([
      { schema: 'public', table: 'accounts', name: 'accounts_pkey' },
      { schema: 'public', table: 'accounts', name: 'accounts_email_key' },
      { schema: 'public', table: 'accounts', name: 'accounts_email_nnd_key' },
      { schema: 'public', table: 'accounts', name: 'accounts_email_include_key' },
      { schema: 'app', table: 'events', name: 'events_account_fkey' },
      { schema: 'public', table: 'accounts', name: 'accounts_email_check' },
    ]),
  )

  expect(snapshot.constraintNameReservations).toHaveLength(6)
}

/**
 * Checks native query order, scope predicates, and reservation-query evidence.
 *
 * @param executedSql - Recorded native catalog SQL in execution order.
 */
function assertPostgresCatalogQueries(executedSql: string[]) {
  const reservationSql = executedSql.find((sql) =>
    sql.includes('c.relname as object_name'),
  )

  expect(reservationSql).toBeDefined()
  expect(reservationSql).not.toContain('relkind in')
  const indexSql = executedSql.find((sql) => sql.includes('from pg_index i'))
  expect(indexSql).toContain('i.indpred is null')
  expect(indexSql).toContain('i.indexprs is null')
  expect(indexSql).toContain('i.indnkeyatts = i.indnatts')
  expect(indexSql).toContain('unnest(i.indoption)')
  expect(indexSql).toContain('unnest(i.indclass)')
  expect(indexSql).toContain('unnest(i.indcollation, i.indkey)')
  expect(indexSql).toContain("to_jsonb(i) ->> 'indnullsnotdistinct'")
  expect(indexSql).not.toContain('i.indnullsnotdistinct')
  const constraintSql = executedSql.find((sql) => sql.includes('from pg_constraint con'))

  expect(constraintSql).toContain('con.conindid')
  expect(constraintSql).toContain("to_jsonb(backing_index) ->> 'indnullsnotdistinct'")

  expect(constraintSql).toContain(
    "jsonb_typeof(to_jsonb(con) -> 'confdelsetcols') = 'array'",
  )

  expect(constraintSql).not.toContain('backing_index.indnullsnotdistinct')
  expect(constraintSql).toContain('backing_index.indnkeyatts = backing_index.indnatts')
  const columnSql = executedSql.find((sql) => sql.includes('-- catalog:column'))
  expect(columnSql).not.toContain('information_schema.columns')
  const opaqueSql = executedSql.find((sql) => sql.includes('from pg_policy'))
  expect(opaqueSql).toContain('p.polpermissive')
  expect(opaqueSql).toContain('p.polcmd')
  expect(opaqueSql).toContain('p.polroles')
}

/**
 * Builds native relation rows with configured kind, deletion, and catalog-race
 * variations.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure
 *   scenarios.
 * @param relationQueries - Number of native relation reads observed by the fixture.
 *
 * @returns Native relation rows with configured kind, deletion, and catalog-race
 *   variations.
 */
function fixtureRelationRows(
  options: NonNullable<Parameters<typeof executor>[0]>,
  relationQueries: number,
) {
  if (options.raced) return []
  if (options.deleted && relationQueries > 1) return []

  const rows = [
    {
      object_id: '1',
      schema: 'public',
      name: 'events',
      relation_kind: options.relationKind ?? 'r',
      persistence: 'p',
      owner: 'app',
      native_definition: null,
      options: ['fillfactor=90'],
      partition_key: null,
      row_level_security: false,
      force_row_level_security: false,
      replica_identity: 'd',
      access_method: 'heap',
      tablespace: null,
      is_partition: false,
      partition_bound: null,
    },
  ]

  if (options.returnedRelationName) rows[0]!.name = options.returnedRelationName

  if (options.unrelatedRace) {
    rows.push({
      ...rows[0]!,
      object_id: String(1000 + relationQueries),
      name: 'audit_log',
    })
  }

  return rows
}

/**
 * Projects one relation's present table evidence into the normalization fixture view.
 *
 * @param relation - Authored or canonical relation addressed by this operation.
 *
 * @returns One relation's present table evidence into the normalization fixture view.
 */
function catalogRelationView(relation: CatalogRelation) {
  if (relation.table.state !== 'present') return []

  const table = relation.table.value
  const schema = relation.identity.namespace.find(({ role }) => role === 'schema')!
    .identifier.spelling

  /** Projects native key evidence into the portable shape used by assertions. */
  const key = (constraint: (typeof table.uniqueConstraints.items)[number]) => ({
    name: constraint.name.state === 'present' ? constraint.name.value : '',
    columns: [...constraint.columns],
    semanticCompleteness:
      constraint.semantics.state === 'present' ? 'supportedSimple' : 'unsupported',
    isValid:
      constraint.validity.state === 'present' && constraint.validity.value === 'valid',
  })

  return [
    {
      name: relation.identity.relation.spelling,
      schema,
      columns: table.columns.items.map(catalogColumnView),
      indexes: table.indexes.items.map((index) => ({
        name: index.name.state === 'present' ? index.name.value : '',
        columns: [...index.columns],
        unique: index.unique,
        semanticCompleteness:
          index.semantics.state === 'present' ? 'supportedSimple' : 'unsupported',
        isValid: index.validity.state === 'present' && index.validity.value === 'valid',
      })),
      primaryKey:
        table.primaryKey.state === 'present' ? key(table.primaryKey.value) : null,
      uniqueConstraints: table.uniqueConstraints.items.map(key),
      foreignKeys: table.foreignKeys.items.map((foreignKey) => ({
        ...key(foreignKey),
        referencedSchema: foreignKey.referencedRelation.namespace.find(
          ({ role }) => role === 'schema',
        )!.identifier.spelling,
        referencedTable: foreignKey.referencedRelation.relation.spelling,
        referencedColumns: [...foreignKey.referencedColumns],
        onDelete: foreignKey.onDelete,
        onUpdate: foreignKey.onUpdate,
      })),
    },
  ]
}

/**
 * Projects native type, nullability, default, and generation facts into the fixture
 * view.
 */
function catalogColumnView(column: CatalogColumn) {
  return {
    name: column.name,
    dataType: column.dataType.state === 'present' ? column.dataType.value.native : '',
    isNullable: column.nullable.state === 'present' && column.nullable.value,
    hasDefault: column.default.state === 'present',
    isIdentity: column.generation.state === 'present',
    defaultExpression:
      column.default.state === 'present' &&
      column.default.value.comparisonKey.state === 'present'
        ? column.default.value.comparisonKey.value
        : null,
    identityGeneration:
      column.generation.state === 'present' && column.generation.value.kind === 'identity'
        ? column.generation.value.mode
        : null,
  }
}

type PostgresFixtureQueryState = { relationQueries: number; columnQueries: number }

/**
 * Dispatches native PostgreSQL catalog queries while recording repeat reads and
 * configured races.
 *
 * @param options - Resolved operation inputs, including sql.
 * @param options - Fixture controls for outcomes, observed calls, and failure
 *   scenarios.
 * @param queryState - Mutable query counters used to inject catalog races on repeat
 *   reads.
 * @param order - Callback applying the configured native row order.
 *
 * @returns Native catalog rows with configured races, ordering, and malformed
 * variations.
 */
async function executePostgresFixture(
  { sql }: Pick<Parameters<CatalogExecutor['execute']>[0], 'sql'>,
  options: PostgresFixtureOptions,
  queryState: PostgresFixtureQueryState,
  order: <T>(rows: T[]) => T[],
) {
  const connection = fixtureConnectionRows(sql, options)

  if (connection) return connection

  if (sql.includes('-- catalog:namespace')) {
    return options.missingNamespace ? [] : [{ schema: 'public', owner: 'app' }]
  }

  if (sql.includes('as relation_kind')) {
    queryState.relationQueries++
    return fixtureRelationRows(options, queryState.relationQueries)
  }

  if (sql.includes('-- catalog:column')) {
    queryState.columnQueries++
    const rows = fixtureColumnRows(options)

    if (options.changedMembers && queryState.columnQueries > 1) rows.pop()

    return order(rows)
  }

  if (sql.includes('from pg_index i'))
    return order(fixtureIndexRows(options.malformedIndex))

  if (sql.includes('from pg_constraint con'))
    return fixtureConstraintRows(options.version)

  const opaque = fixtureOpaqueRows(sql)

  if (opaque) return opaque

  if (sql.includes('as object_name')) {
    return order([
      { schema: 'public', object_name: 'events' },
      { schema: 'public', object_name: 'events_payload_idx' },
    ])
  }

  return []
}

type PostgresFixtureOptions = {
  reverse?: boolean
  version?: string
  raced?: boolean
  deleted?: boolean
  changedMembers?: boolean
  malformedIndex?: boolean
  returnedRelationName?: string
  missingNamespace?: boolean
  unrelatedRace?: boolean
  relationKind?: 'r' | 'v'
}

/**
 * Supplies native trigger evidence outside the portable catalog model.
 *
 * @param sql - Native SQL text being scanned, compiled, or observed.
 *
 * @returns Native trigger evidence outside the portable catalog model.
 */
function fixtureOpaqueRows(sql: string) {
  if (sql.includes('as object_kind')) {
    return [
      {
        schema: 'public',
        table_name: 'events',
        object_kind: 'trigger',
        object_name: 'events_audit',
        native_definition: 'create trigger events_audit ...',
      },
    ]
  }

  return undefined
}

/**
 * Supplies native connection identity and server-version observations.
 *
 * @param sql - Native SQL text being scanned, compiled, or observed.
 * @param options - Fixture controls for outcomes, observed calls, and failure
 *   scenarios.
 *
 * @returns Native connection identity and server-version observations.
 */
function fixtureConnectionRows(sql: string, options: PostgresFixtureOptions) {
  if (sql.includes('current_database()')) {
    return [
      {
        database: 'test',
        schema: 'public',
        version: options.version ?? '160000',
      },
    ]
  }

  return undefined
}

const registerCatalogCases1 = () => {
  it('should keep PostgreSQL 18 NOT NULL constraints as nullable column evidence', async () => {
    const catalog = await postgresDialect.catalog.introspectCatalog(
      executor({ version: '180001' }),
      request,
    )

    const relation = catalog.namespaces.items[0]!.relations.items[0]!

    if (relation.table.state !== 'present') throw new Error('Expected table evidence')

    expect(
      relation.table.value.columns.items.find(({ name }) => name === 'payload')?.nullable,
    ).toEqual({ state: 'present', value: false })

    expect(
      relation.table.value.columns.items.find(({ name }) => name === 'status')?.nullable,
    ).toEqual({ state: 'present', value: false })

    expect(
      relation.table.value.opaqueObjects.items.map(({ name }) =>
        name.state === 'present' ? name.value : undefined,
      ),
    ).toEqual(['events_audit', 'events_payload_check', 'events_status_not_null'])

    expect(catalog.constraintNameReservations.items).toContainEqual(
      expect.objectContaining({
        relation: expect.objectContaining({
          relation: expect.objectContaining({ spelling: 'events' }) as unknown,
        }) as unknown,
        name: 'events_payload_not_null',
      }),
    )
  })
}

const registerCatalogCases2 = () => {
  it('should normalize row-order permutations and preserve native objects', async () => {
    const queries: Parameters<CatalogExecutor['execute']>[0][] = []
    const delegate = executor()
    const first = await postgresDialect.catalog.introspectCatalog(
      {
        /** Executes fixture SQL with the configured native observations. */
        execute(query) {
          queries.push(query)
          return delegate.execute(query)
        },
      },
      request,
    )

    const second = await postgresDialect.catalog.introspectCatalog(
      executor({ reverse: true }),
      request,
    )

    expect(second).toEqual(first)
    const relation = first.namespaces.items[0]!.relations.items[0]!
    expect(relation.identity.relation.spelling).toBe('events')
    expect(relation.table.state).toBe('present')

    if (relation.table.state !== 'present') return

    const richIndex = relation.table.value.indexes.items.find(
      (index) => index.name.state === 'present' && index.name.value.includes('lower'),
    )!

    assertPostgresNativeEvidence(richIndex, relation.table.value)

    expect(relation.table.value.opaqueObjects.items[0]).toMatchObject({
      kind: 'trigger',
      reason: expect.stringMatching(/not managed/i) as unknown,
    })

    expect(first.namespaces.items[0]!.relations.coverage).toMatchObject({
      state: 'partial',
      remainder: { state: 'unmanaged' },
    })

    assertScopedCatalogQueries(queries)

    await assertCompleteNamespaceCoverage()
  })
}

const registerCatalogCases3 = () => {
  it('should ignore unrelated races and skip table-shaped rows for views', async () => {
    const raced = await postgresDialect.catalog.introspectCatalog(
      executor({ unrelatedRace: true }),
      request,
    )

    const identities = raced.namespaces.items.flatMap((namespace) =>
      namespace.relations.items.map((relation) => relation.identity),
    )

    expect(identities).toEqual([
      {
        namespace: [
          {
            role: 'database',
            identifier: { spelling: 'test', comparisonKey: 'test' },
          },
          {
            role: 'schema',
            identifier: { spelling: 'public', comparisonKey: 'public' },
          },
        ],
        relation: { spelling: 'events', comparisonKey: 'events' },
      },
    ])

    const view = await postgresDialect.catalog.introspectCatalog(
      executor({ relationKind: 'v' }),
      request,
    )

    expect(view.namespaces.items[0]!.relations.items[0]!.table).toEqual({
      state: 'absent',
    })
  })
}

const registerCatalogCases4 = () => {
  it('should report unsupported server versions', async () => {
    const versionLimited = await postgresDialect.catalog.introspectCatalog(
      executor({ version: '90600' }),
      request,
    )

    expect(versionLimited.capabilities.identity).toEqual({
      state: 'unavailable',
      cause: 'version',
      actual: '90600',
      requires: '120000',
    })

    expect(versionLimited.namespaces.coverage).toMatchObject({
      state: 'unavailable',
      cause: 'version',
    })

    expect(versionLimited.diagnostics.map(({ code }) => code)).toEqual([
      'catalog.capability.version',
    ])
  })
}

const registerCatalogCases5 = () => {
  it('should reject malformed and cross-query raced rows instead of fabricating facts', async () => {
    await expect(
      postgresDialect.catalog.introspectCatalog(
        executor({ malformedIndex: true }),
        request,
      ),
    ).rejects.toBeInstanceOf(InvariantError)

    await expect(
      postgresDialect.catalog.introspectCatalog(executor({ raced: true }), request),
    ).rejects.toMatchObject({
      _tag: 'MigrationError',
      stage: 'introspection',
      outcome: 'unchanged',
      retryable: true,
    })

    await expect(
      postgresDialect.catalog.introspectCatalog(executor({ deleted: true }), request),
    ).rejects.toMatchObject({
      _tag: 'MigrationError',
      stage: 'introspection',
      outcome: 'unchanged',
      retryable: true,
    })

    await expect(
      postgresDialect.catalog.introspectCatalog(
        executor({ changedMembers: true }),
        request,
      ),
    ).rejects.toMatchObject({
      _tag: 'MigrationError',
      stage: 'introspection',
      outcome: 'unchanged',
      retryable: true,
    })

    await expect(
      postgresDialect.catalog.introspectCatalog(
        executor({ missingNamespace: true }),
        request,
      ),
    ).rejects.toMatchObject({
      _tag: 'MigrationError',
      stage: 'introspection',
      outcome: 'unchanged',
      retryable: true,
    })
  })
}

const registerCatalogCases9 = () => {
  it('should reject an unresolved writable namespace instead of defaulting to public', async () => {
    const executor: Executor = {
      /** Executes fixture SQL with the configured native observations. */
      async execute() {
        return []
      },
      /** Runs a fixture statement with configured outcomes. */
      async run() {},
    }

    await expect(
      postgresDialect.catalog.introspectCatalog(executor, catalogRequest()),
    ).rejects.toThrow(/could not resolve a writable namespace/i)
  })
}

const registerCatalogCases10 = () => {
  it('should normalize catalog rows into a public snapshot', async () => {
    const executedSql: string[] = []
    const executor = normalizationFixtureExecutor(executedSql)

    const observed = await postgresDialect.catalog.introspectCatalog(
      executor,
      catalogRequest(
        { schema: 'public', table: 'accounts' },
        { schema: 'app', table: 'events' },
      ),
    )

    const snapshot = catalogFixtureView(observed)

    assertNormalizedCatalogTables(snapshot)

    assertNormalizedCatalogReservations(snapshot)
    assertPostgresCatalogQueries(executedSql)
  })
}

const registerCatalogCases11 = () => {
  it('should keep dotted schema and relation tuples distinct during introspection', async () => {
    const executor: Executor = createDottedCatalogExecutor()

    const snapshot = catalogFixtureView(
      await postgresDialect.catalog.introspectCatalog(
        executor,
        catalogRequest({ schema: 'a.b', table: 'c' }, { schema: 'a', table: 'b.c' }),
      ),
    )

    expect(
      snapshot.tables.map((table) => ({
        schema: table.schema,
        name: table.name,
        columns: table.columns.map((column) => column.name),
      })),
    ).toEqual([
      { schema: 'a.b', name: 'c', columns: ['schema_marker'] },
      { schema: 'a', name: 'b.c', columns: ['relation_marker'] },
    ])
  })
}

const registerCatalogCases12 = () => {
  it('should reject foreign keys with unresolved referenced relation metadata', async () => {
    const executor: Executor = {
      /** Executes fixture SQL with the configured native observations. */
      async execute({ sql }) {
        if (sql.includes('current_database()')) {
          return [{ database: 'test', schema: 'public', version: '160000' }]
        }

        if (sql.includes('-- catalog:namespace')) {
          return [{ schema: 'public', owner: 'app' }]
        }

        if (sql.includes('as relation_kind')) {
          return structuredClone(
            rejectsForeignKeysWithUnresolvedReferencedRelationMetadataData,
          )
        }

        if (sql.includes('pg_constraint')) {
          return structuredClone(
            rejectsForeignKeysWithUnresolvedReferencedRelationMetadataData2,
          )
        }

        return []
      },
      /** Runs a fixture statement with configured outcomes. */
      async run() {},
    }

    await expect(
      postgresDialect.catalog.introspectCatalog(
        executor,
        catalogRequest({ schema: 'public', table: 'events' }),
      ),
    ).rejects.toThrow(
      /foreign key "events_owner_fkey".*missing referenced relation metadata/i,
    )
  })
}

function registerCatalogGroup1() {
  describe('PostgreSQL catalog', () => {
    registerCatalogCases1()
  })
}

function registerCatalogGroup2() {
  describe('PostgreSQL catalog', () => {
    registerCatalogCases2()
  })
}

function registerCatalogGroup3() {
  describe('PostgreSQL catalog', () => {
    registerCatalogCases3()
  })
}

function registerCatalogGroup4() {
  describe('PostgreSQL catalog', () => {
    registerCatalogCases4()
  })
}

function registerCatalogGroup5() {
  describe('PostgreSQL catalog', () => {
    registerCatalogCases5()
  })
}

function registerCatalogGroup6() {
  it.each([
    ['NUL', 'events\0bad'],
    ['unpaired surrogate', 'events\ud800bad'],
  ])(
    'should keep PostgreSQL returned relation names containing %s as defects',
    async (_, name) => {
      await expect(
        postgresDialect.catalog.introspectCatalog(
          executor({ returnedRelationName: name }),
          request,
        ),
      ).rejects.toBeInstanceOf(InvariantError)
    },
  )
}

function registerCatalogGroup7() {
  it.each(['plan', 'dryRun', 'execute'] as const)(
    'should report a raced PostgreSQL catalog through public migrate().%s()',
    async (method) => {
      const migration = migrationWithCatalogFixture({ changedMembers: true })
      const error = await migration[method]().catch((cause: unknown) => cause)

      expect(error).toBeInstanceOf(MigrationError)

      expect(error).toMatchObject({
        _tag: 'MigrationError',
        stage: 'introspection',
        outcome: 'unchanged',
        retryable: true,
      })

      expect((error as MigrationError).defect).toBeUndefined()
    },
  )
}

function registerCatalogGroup8() {
  it('should preserve malformed PostgreSQL rows as defects through public migration', async () => {
    const preview = migrationWithCatalogFixture({ malformedIndex: true })
    await expect(preview.plan()).rejects.toBeInstanceOf(InvariantError)

    const execution = migrationWithCatalogFixture({ malformedIndex: true })
    const error = await execution.execute().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'introspection',
      outcome: 'unchanged',
      defect: true,
    })

    expect((error as MigrationError).cause).toBeInstanceOf(InvariantError)
  })
}

function registerCatalogGroup9() {
  describe('PostgreSQL catalog', () => {
    registerCatalogCases9()
  })
}

function registerCatalogGroup10() {
  describe('PostgreSQL catalog', () => {
    registerCatalogCases10()
  })
}

function registerCatalogGroup11() {
  describe('PostgreSQL catalog', () => {
    registerCatalogCases11()
  })
}

function registerCatalogGroup12() {
  describe('PostgreSQL catalog', () => {
    registerCatalogCases12()
  })
}

describe('PostgreSQL catalog', () => {
  registerCatalogGroup1()
  registerCatalogGroup2()
  registerCatalogGroup3()
  registerCatalogGroup4()
  registerCatalogGroup5()
  registerCatalogGroup6()
  registerCatalogGroup7()
  registerCatalogGroup8()
  registerCatalogGroup9()
  registerCatalogGroup10()
  registerCatalogGroup11()
  registerCatalogGroup12()
})
