import type {
  MetadataAction,
  NumberSchema,
  ObjectSchema,
  SchemaWithPipe,
  StringSchema,
  TitleAction,
} from 'valibot'
import {
  bigint,
  date,
  decimal,
  enum as enumSchema,
  integer,
  ip,
  isoDate,
  isoDateTime,
  isoTime,
  isoTimeSecond,
  isoTimestamp,
  mac48,
  mac64,
  maxLength,
  maxValue,
  minValue,
  null as nullSchema,
  nullable,
  number,
  object,
  picklist,
  pipe,
  string,
  transform,
  union,
  uuid,
} from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { lowerDesiredSchema, registerDesiredSchema } from '@/ddl/desiredSchema'
import { postgresDialect } from '@/dialects'
import { POSTGRES_IDENTITY_POLICY } from '@/dialects/postgres/identity'
import type { LoweredDesiredTable } from '@/dialects/types'
import type { TableMetadata } from '@/index'
import { MigrationError, SchemaError, column, defineTable, reference } from '@/index'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import { validateInsertRow } from '@/query'
import type { TableHandle } from '@/types'
import type { AnySchema } from '@/types/schema'
import { attemptSync } from '@/utils/error'

import { relation as canonicalRelation, identifier } from '../helpers/planTargets'

/** Builds a date column stored in PostgreSQL text with optional column metadata. */
const overriddenDate = (metadata: Parameters<typeof column>[0] = {}) =>
  defineTable(
    'override_storage',
    {
      id: string(),
      value: pipe(
        date(),
        column({ physicalType: { postgresql: 'text', sqlite: 'TEXT' }, ...metadata }),
      ),
    },
    { primaryKey: 'id' },
  )

/**
 * Creates canonical PostgreSQL identities under the fixture's writable namespace
 * default.
 */
const postgresIdentities = () =>
  createCanonicalRelationIdentityModule({
    policy: POSTGRES_IDENTITY_POLICY,
    context: {
      writableDefault: [
        { role: 'database', spelling: 'test' },
        { role: 'schema', spelling: 'public' },
      ],
    },
  })

/** Creates direct, nullable, and chained references to one formatted target. */
function nativeReferenceHandles(schema: AnySchema) {
  const Parent = defineTable('native_parents', { id: schema }, { primaryKey: 'id' })
  const Child = defineTable(
    'native_children',
    {
      id: string(),
      parentId: reference(Parent, 'id'),
      nullableId: nullable(reference(Parent, 'id')),
    },
    { primaryKey: 'id', indexes: [{ columns: ['parentId'], unique: true }] },
  )

  const Grandchild = defineTable(
    'native_grandchildren',
    {
      id: string(),
      parentId: reference(Child, 'parentId'),
    },
    { primaryKey: 'id' },
  )

  return { Parent, Child, Grandchild }
}

/**
 * Builds table handles covering supported PostgreSQL storage, keys, and indexes.
 *
 * @returns Table handles covering supported PostgreSQL storage, keys, and indexes.
 */
function supportedSchemaHandles() {
  const Accounts = createAccountsTable()
  const Memberships = defineTable(
    'memberships',
    {
      accountId: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      memberId: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    },
    { primaryKey: ['accountId', 'memberId'] },
  )

  const References = defineTable(
    'references',
    {
      id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      accountCode: reference(Accounts, 'code', {
        onDelete: 'cascade',
        onUpdate: 'restrict',
      }),
    },
    { primaryKey: 'id' },
  )

  return { Accounts, Memberships, References }
}

/** Creates a UUID-validated target with the selected PostgreSQL storage. */
function uuidReferenceParent(targetType: string) {
  return defineTable(
    'uuid_parents',
    {
      id:
        targetType === 'uuid'
          ? pipe(string(), uuid())
          : pipe(string(), uuid(), column({ physicalType: { postgresql: targetType } })),
    },
    { primaryKey: 'id' },
  )
}

/** Finds a lowered column in the registered desired-schema graph. */
function loweredColumn(
  tables: readonly Omit<LoweredDesiredTable, 'handle'>[],
  tableName: string,
  columnName: string,
) {
  return tables
    .find((table) => table.identity.relation.spelling === tableName)
    ?.columns.find((item) => item.identifier.spelling === columnName)
}

const expectedSupportedSchemaGraph = [
  {
    identity: canonicalRelation('public', 'accounts'),
    columns: [
      {
        identifier: identifier('id'),
        dataType: 'integer',
        notNull: true,
        unique: false,
        autoIncrement: false,
        generated: 'byDefault',
      },
      {
        identifier: identifier('code'),
        dataType: 'text',
        notNull: true,
        unique: true,
        autoIncrement: false,
      },
      {
        identifier: identifier('nullableLabel'),
        dataType: 'text',
        notNull: false,
        unique: false,
        autoIncrement: false,
      },
      {
        identifier: identifier('literalStatus'),
        dataType: 'text',
        notNull: true,
        unique: false,
        autoIncrement: false,
        databaseDefault: { sql: "'ready'", normalized: "'ready'" },
      },
      {
        identifier: identifier('currentTimestamp'),
        dataType: 'timestamptz',
        notNull: true,
        unique: false,
        autoIncrement: false,
        databaseDefault: {
          sql: 'current_timestamp',
          normalized: 'current_timestamp',
        },
      },
      {
        identifier: identifier('currentDate'),
        dataType: 'date',
        notNull: true,
        unique: false,
        autoIncrement: false,
        databaseDefault: { sql: 'current_date', normalized: 'current_date' },
      },
      {
        identifier: identifier('currentTime'),
        dataType: 'time',
        notNull: true,
        unique: false,
        autoIncrement: false,
        databaseDefault: { sql: 'current_time', normalized: 'current_time' },
      },
      {
        identifier: identifier('dialectClock'),
        dataType: 'timestamptz',
        notNull: true,
        unique: false,
        autoIncrement: false,
        databaseDefault: {
          sql: 'clock_timestamp()',
          normalized: 'clock_timestamp()',
        },
      },
      {
        identifier: identifier('sequence'),
        dataType: 'bigint',
        notNull: true,
        unique: false,
        autoIncrement: false,
        generated: 'always',
      },
    ],
    primaryKey: [identifier('id')],
  },
  {
    identity: canonicalRelation('public', 'memberships'),
    columns: [
      {
        identifier: identifier('accountId'),
        dataType: 'uuid',
        notNull: true,
        unique: false,
        autoIncrement: false,
      },
      {
        identifier: identifier('memberId'),
        dataType: 'uuid',
        notNull: true,
        unique: false,
        autoIncrement: false,
      },
    ],
    primaryKey: [identifier('accountId'), identifier('memberId')],
  },
  {
    identity: canonicalRelation('public', 'references'),
    columns: [
      {
        identifier: identifier('id'),
        dataType: 'uuid',
        notNull: true,
        unique: false,
        autoIncrement: false,
      },
      {
        identifier: identifier('accountCode'),
        dataType: 'text',
        notNull: true,
        unique: false,
        autoIncrement: false,
        reference: {
          relation: canonicalRelation('public', 'accounts'),
          column: identifier('code'),
          onDelete: 'cascade',
          onUpdate: 'restrict',
        },
      },
    ],
    primaryKey: [identifier('id')],
  },
]

/**
 * Builds a fresh bad identity table handle for the schema scenario.
 *
 * @returns A fresh bad identity table handle for the schema scenario.
 */
function createBadIdentityTable() {
  return defineTable(
    'bad_identity',
    {
      id: pipe(
        string(),
        column({
          physicalType: { postgresql: 'uuid' },
          generation: { kind: 'identity', mode: 'byDefault' },
        }),
      ),
    },
    { primaryKey: 'id' },
  )
}

/**
 * Builds a fresh computed table handle for the schema scenario.
 *
 * @param Target - Table handle used to exercise target schema behavior.
 *
 * @returns A fresh computed table handle for the schema scenario.
 */
function createComputedTable(
  Target: TableHandle<
    SchemaWithPipe<
      readonly [
        ObjectSchema<
          {
            id: SchemaWithPipe<
              readonly [
                StringSchema<undefined>,
                MetadataAction<
                  string,
                  { physicalType: { postgresql: string } } & { kind: 'column' }
                >,
              ]
            >
          },
          undefined
        >,
        TitleAction<{ id: string }, 'reference_option_targets'>,
        MetadataAction<{ id: string }, TableMetadata<'reference_option_targets'>>,
      ]
    >,
    Readonly<{ relation: 'reference_option_targets' }>
  >,
) {
  return defineTable(
    'reference_computed',
    {
      id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      targetId: pipe(
        reference(Target, 'id'),
        column({
          generation: {
            kind: 'computed',
            expression: {
              kind: 'dialectExpression',
              dialect: 'postgresql',
              expression: 'lower(id::text)',
            },
            storage: 'stored',
          },
        }),
      ),
    },
    { primaryKey: 'id' },
  )
}

/**
 * Builds a fresh invalid table handle for the schema scenario.
 *
 * @param expression - Scalar SQL expression or default expression being processed.
 *
 * @returns A fresh invalid table handle for the schema scenario.
 */
function createInvalidTable(expression: string) {
  return defineTable(
    'invalid_expression',
    {
      id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      value: pipe(
        string(),
        column({
          physicalType: { postgresql: 'text' },
          databaseDefault: {
            kind: 'dialectExpression',
            dialect: 'postgresql',
            expression,
          },
        }),
      ),
    },
    { primaryKey: 'id' },
  )
}

/**
 * Builds a fresh defaults table handle for the schema scenario.
 *
 * @returns A fresh defaults table handle for the schema scenario.
 */
function createDefaultsTable() {
  return defineTable(
    'defaults',
    {
      id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      literal: pipe(
        string(),
        column({
          physicalType: { postgresql: 'text' },
          databaseDefault: { kind: 'literal', value: 'now()' },
        }),
      ),
      path: pipe(
        string(),
        column({
          physicalType: { postgresql: 'text' },
          databaseDefault: { kind: 'literal', value: "C:\\O'Brien\\" },
        }),
      ),
      portable: pipe(
        string(),
        column({
          physicalType: { postgresql: 'timestamptz' },
          databaseDefault: {
            kind: 'portableExpression',
            expression: 'currentTimestamp',
          },
        }),
      ),
      dialect: pipe(
        string(),
        column({
          physicalType: { postgresql: 'timestamptz' },
          databaseDefault: {
            kind: 'dialectExpression',
            dialect: 'postgresql',
            expression: 'now()',
          },
        }),
      ),
    },
    { primaryKey: 'id' },
  )
}

/**
 * Builds a fresh matching table handle for the schema scenario.
 *
 * @param Target - Table handle used to exercise target schema behavior.
 *
 * @returns A fresh matching table handle for the schema scenario.
 */
function createMatchingTable(
  Target: TableHandle<
    SchemaWithPipe<
      readonly [
        ObjectSchema<
          {
            id: SchemaWithPipe<
              readonly [
                NumberSchema<undefined>,
                MetadataAction<
                  number,
                  { physicalType: { postgresql: string } } & { kind: 'column' }
                >,
              ]
            >
          },
          undefined
        >,
        TitleAction<{ id: number }, 'typed_targets'>,
        MetadataAction<{ id: number }, TableMetadata<'typed_targets'>>,
      ]
    >,
    Readonly<{ relation: 'typed_targets' }>
  >,
) {
  return defineTable(
    'matching_refs',
    {
      id: pipe(number(), column({ physicalType: { postgresql: 'integer' } })),
      legacy: pipe(
        reference(Target, 'id'),
        column({ physicalType: { postgresql: 'int4' } }),
      ),
      selected: pipe(
        reference(Target, 'id'),
        column({ physicalType: { postgresql: 'integer', sqlite: 'blob' } }),
      ),
      unrelated: pipe(
        reference(Target, 'id'),
        column({ physicalType: { sqlite: 'blob' } }),
      ),
    },
    { primaryKey: 'id' },
  )
}

/**
 * Builds a fresh capability reverse table handle for the schema scenario.
 *
 * @param computed - Computed-column fixture whose values must be omitted from writes.
 *
 * @returns A fresh capability reverse table handle for the schema scenario.
 */
function createCapabilityReverseTable(computed: {
  kind: 'computed'
  expression: { kind: 'dialectExpression'; dialect: 'postgresql'; expression: string }
  storage: 'stored'
}) {
  return defineTable(
    'deterministic_capability',
    {
      id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      alpha: pipe(
        string(),
        column({
          physicalType: { postgresql: 'text' },
          databaseDefault: { kind: 'literal', value: Number.POSITIVE_INFINITY },
        }),
      ),
      zeta: pipe(
        string(),
        column({ physicalType: { postgresql: 'text' }, generation: computed }),
      ),
    },
    { primaryKey: 'id' },
  )
}

/**
 * Builds a fresh capability forward table handle for the schema scenario.
 *
 * @param computed - Computed-column fixture whose values must be omitted from writes.
 *
 * @returns A fresh capability forward table handle for the schema scenario.
 */
function createCapabilityForwardTable(computed: {
  kind: 'computed'
  expression: { kind: 'dialectExpression'; dialect: 'postgresql'; expression: string }
  storage: 'stored'
}) {
  return defineTable(
    'deterministic_capability',
    {
      zeta: pipe(
        string(),
        column({ physicalType: { postgresql: 'text' }, generation: computed }),
      ),
      alpha: pipe(
        string(),
        column({
          physicalType: { postgresql: 'text' },
          databaseDefault: { kind: 'literal', value: Number.POSITIVE_INFINITY },
        }),
      ),
      id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    },
    { primaryKey: 'id' },
  )
}

/**
 * Builds a fresh physical reverse table handle for the schema scenario.
 *
 * @returns A fresh physical reverse table handle for the schema scenario.
 */
function createPhysicalReverseTable() {
  return defineTable(
    'deterministic_physical',
    {
      id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      alpha: pipe(
        string(),
        column({ physicalType: { postgresql: 'unsupported_alpha' } }),
      ),
      zeta: pipe(string(), column({ physicalType: { postgresql: 'unsupported_zeta' } })),
    },
    { primaryKey: 'id' },
  )
}

/**
 * Builds a fresh physical forward table handle for the schema scenario.
 *
 * @returns A fresh physical forward table handle for the schema scenario.
 */
function createPhysicalForwardTable() {
  return defineTable(
    'deterministic_physical',
    {
      zeta: pipe(string(), column({ physicalType: { postgresql: 'unsupported_zeta' } })),
      alpha: pipe(
        string(),
        column({ physicalType: { postgresql: 'unsupported_alpha' } }),
      ),
      id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    },
    { primaryKey: 'id' },
  )
}

/**
 * Builds a fresh accounts table handle for the schema scenario.
 *
 * @returns A fresh accounts table handle for the schema scenario.
 */
function createAccountsTable() {
  return defineTable(
    'accounts',
    {
      id: pipe(
        number(),
        column({
          physicalType: { postgresql: 'integer' },
          generation: { kind: 'identity', mode: 'byDefault' },
        }),
      ),
      code: pipe(string(), column({ unique: true })),
      nullableLabel: nullable(string()),
      literalStatus: pipe(
        string(),
        column({ databaseDefault: { kind: 'literal', value: 'ready' } }),
      ),
      ...createTemporalAccountColumns(),
      dialectClock: pipe(
        string(),
        column({
          physicalType: { postgresql: 'timestamptz' },
          databaseDefault: {
            kind: 'dialectExpression',
            dialect: 'postgresql',
            expression: 'clock_timestamp()',
          },
        }),
      ),
      sequence: pipe(
        number(),
        column({
          physicalType: { postgresql: 'bigint' },
          generation: { kind: 'identity', mode: 'always' },
        }),
      ),
    },
    { primaryKey: 'id' },
  )
}

/**
 * Checks rejected dialect tags and unsupported PostgreSQL generation metadata.
 *
 * @param Mismatched - Table handle used to exercise mismatched schema behavior.
 * @param Computed - Table handle used to exercise computed schema behavior.
 */
function assertInvalidPostgresColumnMetadata(
  Mismatched: TableHandle,
  Computed: TableHandle,
) {
  expect(() =>
    lowerDesiredSchema([Mismatched], postgresIdentities(), postgresDialect.schema),
  ).toThrow(
    new MigrationError({
      message: 'PostgreSQL cannot lower database expression tagged for dialect "sqlite"',
    }),
  )

  expect(() =>
    lowerDesiredSchema([Computed], postgresIdentities(), postgresDialect.schema),
  ).toThrow(
    new MigrationError({
      message:
        'PostgreSQL computed generation is not supported by this migration adapter',
    }),
  )
}

/**
 * Checks inherited reference types and rejection of incompatible local physical
 * overrides.
 *
 * @param LegacyMismatch - Table handle used to exercise legacy mismatch schema
 *   behavior.
 * @param Target - Table handle used to exercise target schema behavior.
 * @param SelectedMismatch - Table handle used to exercise selected mismatch schema
 *   behavior.
 */
function assertPostgresReferenceTypeCompatibility(
  LegacyMismatch: TableHandle,
  Target: TableHandle,
  SelectedMismatch: TableHandle,
) {
  expect(() =>
    lowerDesiredSchema(
      [LegacyMismatch, Target],
      postgresIdentities(),
      postgresDialect.schema,
    ),
  ).toThrow(
    new MigrationError({
      message:
        'Reference column [database:"test", schema:"public", relation:"legacy_mismatch", column:"targetId"] selects PostgreSQL type "text" but target type is "integer"',
    }),
  )

  expect(() =>
    lowerDesiredSchema(
      [SelectedMismatch, Target],
      postgresIdentities(),
      postgresDialect.schema,
    ),
  ).toThrow(
    new MigrationError({
      message:
        'Reference column [database:"test", schema:"public", relation:"selected_mismatch", column:"targetId"] selects PostgreSQL type "bigint" but target type is "integer"',
    }),
  )
}

/** Creates the temporal account columns fixture used by the contract scenario. */
function createTemporalAccountColumns() {
  return {
    currentTimestamp: pipe(
      string(),
      column({
        physicalType: { postgresql: 'timestamptz' },
        databaseDefault: {
          kind: 'portableExpression',
          expression: 'currentTimestamp',
        },
      }),
    ),
    currentDate: pipe(
      string(),
      column({
        physicalType: { postgresql: 'date' },
        databaseDefault: {
          kind: 'portableExpression',
          expression: 'currentDate',
        },
      }),
    ),
    currentTime: pipe(
      string(),
      column({
        physicalType: { postgresql: 'time' },
        databaseDefault: {
          kind: 'portableExpression',
          expression: 'currentTime',
        },
      }),
    ),
  }
}

const registerDesiredSchemaCases13 = () => {
  it('should lower composite nullability, selected override, and inherited reference storage', () => {
    const Parent = defineTable(
      'composite_parent',
      {
        id: pipe(union([number(), number()]), integer(), minValue(0), maxValue(100)),
        value: pipe(
          union([string(), nullSchema()]),
          column({ physicalType: { postgresql: 'varchar(20)', sqlite: 'BLOB' } }),
        ),
      },
      { primaryKey: 'id' },
    )

    const Child = defineTable(
      'composite_child',
      {
        id: string(),
        parentId: reference(Parent, 'id'),
      },
      { primaryKey: 'id' },
    )

    const tables = lowerDesiredSchema(
      [Child, Parent],
      postgresIdentities(),
      postgresDialect.schema,
    ).tables

    const parent = tables.find(
      (table) => table.identity.relation.spelling === 'composite_parent',
    )!

    const child = tables.find(
      (table) => table.identity.relation.spelling === 'composite_child',
    )!

    expect(
      parent.columns.find((column) => column.identifier.spelling === 'id'),
    ).toMatchObject({ dataType: 'smallint', notNull: true })

    expect(
      parent.columns.find((column) => column.identifier.spelling === 'value'),
    ).toMatchObject({ dataType: 'varchar(20)', notNull: false })

    expect(
      child.columns.find((column) => column.identifier.spelling === 'parentId'),
    ).toMatchObject({ dataType: 'smallint', notNull: true })
  })
}

const registerDesiredSchemaCases21 = () => {
  it('should infer a UUID primary key and nullable UUID column, with selected overrides winning', () => {
    const Users = defineTable(
      'uuid_users',
      {
        id: pipe(string(), uuid()),
        optionalId: nullable(pipe(string(), maxLength(36), uuid())),
        textId: pipe(string(), uuid(), column({ physicalType: { postgresql: 'text' } })),
        varcharId: pipe(
          string(),
          uuid(),
          column({ physicalType: { postgresql: 'varchar(36)' } }),
        ),
        selectedUuid: pipe(
          string(),
          uuid(),
          column({ physicalType: { postgresql: 'uuid' } }),
        ),
        sqliteOverride: pipe(
          string(),
          uuid(),
          column({ physicalType: { sqlite: 'BLOB' } }),
        ),
      },
      { primaryKey: 'id' },
    )

    const table = lowerDesiredSchema(
      [Users],
      postgresIdentities(),
      postgresDialect.schema,
    ).tables[0]!

    const columns = Object.fromEntries(
      table.columns.map((item) => [item.identifier.spelling, item]),
    )

    expect(table.primaryKey).toEqual([identifier('id')])
    expect(columns.id).toMatchObject({ dataType: 'uuid', notNull: true })
    expect(columns.optionalId).toMatchObject({ dataType: 'uuid', notNull: false })
    expect(columns.textId.dataType).toBe('text')
    expect(columns.varcharId.dataType).toBe('varchar(36)')
    expect(columns.selectedUuid.dataType).toBe('uuid')
    expect(columns.sqliteOverride.dataType).toBe('uuid')
  })
}

const registerDesiredSchemaCases22 = () => {
  it.each(['uuid', 'text', 'varchar(36)'])(
    'should inherit selected %s storage through direct, nullable, and chained references',
    (targetType) => {
      const Parent = uuidReferenceParent(targetType)
      const Child = defineTable(
        'uuid_children',
        {
          id: string(),
          parentId: reference(Parent, 'id'),
          nullableParentId: nullable(reference(Parent, 'id')),
        },
        { primaryKey: 'id', indexes: [{ columns: ['parentId'], unique: true }] },
      )

      const Grandchild = defineTable(
        'uuid_grandchildren',
        { id: string(), parentId: reference(Child, 'parentId') },
        { primaryKey: 'id' },
      )

      const tables = lowerDesiredSchema(
        [Grandchild, Child, Parent],
        postgresIdentities(),
        postgresDialect.schema,
      ).tables

      expect(loweredColumn(tables, 'uuid_parents', 'id')?.dataType).toBe(targetType)

      expect(loweredColumn(tables, 'uuid_children', 'parentId')?.dataType).toBe(
        targetType,
      )

      expect(loweredColumn(tables, 'uuid_children', 'nullableParentId')).toMatchObject({
        dataType: targetType,
        notNull: false,
      })

      expect(loweredColumn(tables, 'uuid_grandchildren', 'parentId')?.dataType).toBe(
        targetType,
      )
    },
  )
}

const registerDesiredSchemaCases23 = () => {
  it.each(['uuid', 'text', 'varchar(36)'])(
    'should accept matching %s and reject mismatched local storage',
    (targetType) => {
      const Parent = uuidReferenceParent(targetType)
      const Matching = defineTable(
        'matching_uuid_refs',
        {
          id: string(),
          parentId: pipe(
            reference(Parent, 'id'),
            column({ physicalType: { postgresql: targetType } }),
          ),
        },
        { primaryKey: 'id' },
      )

      const matching = lowerDesiredSchema(
        [Matching, Parent],
        postgresIdentities(),
        postgresDialect.schema,
      ).tables

      expect(loweredColumn(matching, 'matching_uuid_refs', 'parentId')?.dataType).toBe(
        targetType,
      )

      const mismatch = targetType === 'uuid' ? 'text' : 'uuid'
      const Mismatch = defineTable(
        'mismatched_uuid_refs',
        {
          id: string(),
          parentId: pipe(
            reference(Parent, 'id'),
            column({ physicalType: { postgresql: mismatch } }),
          ),
        },
        { primaryKey: 'id' },
      )

      expect(() =>
        lowerDesiredSchema(
          [Mismatch, Parent],
          postgresIdentities(),
          postgresDialect.schema,
        ),
      ).toThrow(MigrationError)
    },
  )
}

const registerDesiredSchemaCases24 = () => {
  it('should lower every supported metadata and reference form to one fixed schema graph', () => {
    const { Accounts, Memberships, References } = supportedSchemaHandles()

    const lowered = lowerDesiredSchema(
      [References, Memberships, Accounts],
      postgresIdentities(),
      postgresDialect.schema,
    )

    expect(
      lowered.tables.map(({ identity, columns, primaryKey }) => ({
        identity,
        columns,
        primaryKey,
      })),
    ).toEqual(expectedSupportedSchemaGraph)
  })
}

const registerDesiredSchemaCases25 = () => {
  it('should report the same first lowering error across column-order permutations', () => {
    /**
     * Lowers ing error for the current fixture scenario.
     *
     * @param table - Table metadata or evidence used to resolve its members.
     *
     * @returns The expected MigrationError; successful lowering fails the test.
     */
    const loweringError = (table: TableHandle): MigrationError => {
      const result = attemptSync(() =>
        lowerDesiredSchema([table], postgresIdentities(), postgresDialect.schema),
      )

      if (result.ok) throw new Error('Expected desired-schema lowering to fail')

      expect(result.error).toBeInstanceOf(MigrationError)
      return result.error as MigrationError
    }

    const PhysicalForward = createPhysicalForwardTable()
    const PhysicalReverse = createPhysicalReverseTable()
    const physicalForward = loweringError(PhysicalForward)
    const physicalReverse = loweringError(PhysicalReverse)
    expect(physicalForward.message).toBe(physicalReverse.message)
    expect(physicalForward.message).toMatch(/unsupported_alpha/)

    const computed = {
      kind: 'computed' as const,
      expression: {
        kind: 'dialectExpression' as const,
        dialect: 'postgresql' as const,
        expression: 'lower(id::text)',
      },
      storage: 'stored' as const,
    }

    const CapabilityForward = createCapabilityForwardTable(computed)
    const CapabilityReverse = createCapabilityReverseTable(computed)
    const capabilityForward = loweringError(CapabilityForward)
    const capabilityReverse = loweringError(CapabilityReverse)
    expect(capabilityForward.message).toBe(capabilityReverse.message)
    expect(capabilityForward.message).toMatch(/finite/)
  })
}

const registerDesiredSchemaCases26 = () => {
  it('should acknowledge matching local reference types and reject mismatches', () => {
    const Target = defineTable(
      'typed_targets',
      { id: pipe(number(), column({ physicalType: { postgresql: 'integer' } })) },
      { primaryKey: 'id' },
    )

    const Matching = createMatchingTable(Target)
    const matching = lowerDesiredSchema(
      [Matching, Target],
      postgresIdentities(),
      postgresDialect.schema,
    ).tables.find((table) => table.identity.relation.spelling === 'matching_refs')!

    expect(
      matching.columns
        .filter((value) => value.identifier.spelling !== 'id')
        .map((value) => value.dataType),
    ).toEqual(['integer', 'integer', 'integer'])

    const LegacyMismatch = defineTable(
      'legacy_mismatch',
      {
        id: pipe(number(), column({ physicalType: { postgresql: 'integer' } })),
        targetId: pipe(
          reference(Target, 'id'),
          column({ physicalType: { postgresql: 'text' } }),
        ),
      },
      { primaryKey: 'id' },
    )

    const SelectedMismatch = defineTable(
      'selected_mismatch',
      {
        id: pipe(number(), column({ physicalType: { postgresql: 'integer' } })),
        targetId: pipe(
          reference(Target, 'id'),
          column({ physicalType: { postgresql: 'bigint' } }),
        ),
      },
      { primaryKey: 'id' },
    )

    assertPostgresReferenceTypeCompatibility(LegacyMismatch, Target, SelectedMismatch)
  })
}

const registerDesiredSchemaCases27 = () => {
  it('should distinguish tagged literals from portable and dialect expressions', () => {
    const Defaults = createDefaultsTable()
    const table = lowerDesiredSchema(
      [Defaults],
      postgresIdentities(),
      postgresDialect.schema,
    ).tables[0]!

    const defaults = table.columns.map((column) => column.databaseDefault?.sql)

    expect(defaults).toContain(`'now()'`)
    expect(defaults).toContain("E'C:\\\\O''Brien\\\\'")
    expect(defaults).toContain('current_timestamp')
    expect(defaults).toContain('now()')
  })
}

const registerDesiredSchemaCases28 = () => {
  it('should reject unbalanced or dollar-quoted dialect expressions', () => {
    for (const expression of [
      "'unterminated",
      '(now()',
      ')now()(',
      '$$now()$$',
      '$tag$now()$tag$',
    ]) {
      const Invalid = createInvalidTable(expression)
      expect(() =>
        lowerDesiredSchema([Invalid], postgresIdentities(), postgresDialect.schema),
      ).toThrow(/unsafe PostgreSQL database expression/i)
    }

    const Valid = defineTable(
      'valid_expression',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        value: pipe(
          string(),
          column({
            physicalType: { postgresql: 'text' },
            databaseDefault: {
              kind: 'dialectExpression',
              dialect: 'postgresql',
              expression: "coalesce(nullif('it''s )', ''), 'fallback')",
            },
          }),
        ),
      },
      { primaryKey: 'id' },
    )

    expect(() =>
      lowerDesiredSchema([Valid], postgresIdentities(), postgresDialect.schema),
    ).not.toThrow()
  })
}

const registerDesiredSchemaCases29 = () => {
  it('should report missing direct-lowering reference targets as MigrationError', () => {
    const Target = defineTable(
      'direct_targets',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        label: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
      },
      { primaryKey: 'id' },
    )

    const Source = defineTable(
      'direct_sources',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        targetId: reference(Target, 'id'),
      },
      { primaryKey: 'id' },
    )

    const graph = registerDesiredSchema([Source, Target], postgresIdentities())

    expect(() =>
      postgresDialect.schema.lowerDesiredSchema({
        tables: graph.tables.filter(
          (table) => table.identity.relation.spelling !== Target.getTableMetadata().name,
        ),
      }),
    ).toThrow(/unregistered relation/i)

    expect(() =>
      postgresDialect.schema.lowerDesiredSchema({
        tables: graph.tables.map((table) =>
          table.identity.relation.spelling === Target.getTableMetadata().name
            ? {
                ...table,
                columns: table.columns.filter((column) => column.name !== 'id'),
              }
            : table,
        ),
      }),
    ).toThrow(/missing column/i)
  })
}

const registerDesiredSchemaCases30 = () => {
  it('should reject mismatched tags and unsupported generation with MigrationError', () => {
    const Mismatched = defineTable(
      'mismatched',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        value: pipe(
          string(),
          column({
            physicalType: { postgresql: 'text' },
            databaseDefault: {
              kind: 'dialectExpression',
              dialect: 'sqlite',
              expression: 'CURRENT_TIMESTAMP',
            },
          }),
        ),
      },
      { primaryKey: 'id' },
    )

    const Computed = defineTable(
      'computed',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        value: pipe(
          string(),
          column({
            physicalType: { postgresql: 'text' },
            generation: {
              kind: 'computed',
              expression: {
                kind: 'dialectExpression',
                dialect: 'postgresql',
                expression: 'lower(id)',
              },
              storage: 'stored',
            },
          }),
        ),
      },
      { primaryKey: 'id' },
    )

    assertInvalidPostgresColumnMetadata(Mismatched, Computed)
  })
}

const registerDesiredSchemaCases31 = () => {
  it('should defer comments, onUpdate, and identity type checks to PostgreSQL lowering', () => {
    const BadIdentity = createBadIdentityTable()
    const Commented = defineTable(
      'commented',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        value: pipe(
          string(),
          column({ physicalType: { postgresql: 'text' }, comment: 'value' }),
        ),
      },
      { primaryKey: 'id' },
    )

    const Updated = defineTable(
      'updated',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        value: pipe(
          string(),
          column({ physicalType: { postgresql: 'text' }, onUpdate: 'now()' }),
        ),
      },
      { primaryKey: 'id' },
    )

    for (const [table, message] of [
      [BadIdentity, /identity/i],
      [Commented, /comments/i],
      [Updated, /onUpdate/i],
    ] as const) {
      expect(() =>
        lowerDesiredSchema([table], postgresIdentities(), postgresDialect.schema),
      ).toThrow(MigrationError)

      expect(() =>
        lowerDesiredSchema([table], postgresIdentities(), postgresDialect.schema),
      ).toThrow(message)
    }
  })
}

const registerDesiredSchemaCases32 = () => {
  it('should reject unsupported local metadata on composed reference columns', () => {
    const Target = defineTable(
      'reference_option_targets',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )

    const Commented = defineTable(
      'reference_commented',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        targetId: pipe(reference(Target, 'id'), column({ comment: 'target' })),
      },
      { primaryKey: 'id' },
    )

    const Updated = defineTable(
      'reference_updated',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        targetId: pipe(reference(Target, 'id'), column({ onUpdate: 'now()' })),
      },
      { primaryKey: 'id' },
    )

    const Computed = createComputedTable(Target)

    for (const [source, message] of [
      [Commented, /comments/i],
      [Updated, /onUpdate/i],
      [Computed, /computed generation/i],
    ] as const) {
      expect(() =>
        lowerDesiredSchema(
          [source, Target],
          postgresIdentities(),
          postgresDialect.schema,
        ),
      ).toThrow(MigrationError)

      expect(() =>
        lowerDesiredSchema(
          [source, Target],
          postgresIdentities(),
          postgresDialect.schema,
        ),
      ).toThrow(message)
    }
  })
}

const registerDesiredSchemaCases33 = () => {
  it('should keep by-default identity explicitly insertable and always/computed omitted', () => {
    const Generated = defineTable(
      'generated',
      {
        id: pipe(
          number(),
          column({
            physicalType: { postgresql: 'integer' },
            generation: { kind: 'identity', mode: 'byDefault' },
          }),
        ),
        always: pipe(
          number(),
          column({
            physicalType: { postgresql: 'integer' },
            generation: { kind: 'identity', mode: 'always' },
          }),
        ),
        computed: pipe(
          string(),
          column({
            physicalType: { postgresql: 'text' },
            generation: {
              kind: 'computed',
              expression: {
                kind: 'portableExpression',
                expression: 'currentTimestamp',
              },
              storage: 'stored',
            },
          }),
        ),
      },
      { primaryKey: 'id' },
    )

    expect(validateInsertRow(Generated, {})).toEqual({})
    expect(validateInsertRow(Generated, { id: 1 })).toEqual({ id: 1 })
    expect(() => validateInsertRow(Generated, { always: 1 })).toThrow(/non-insertable/i)

    expect(() => validateInsertRow(Generated, { computed: 'x' })).toThrow(
      /non-insertable/i,
    )
  })
}

const registerDesiredSchemaCases34 = () => {
  it('should lower identity generation modes', () => {
    const Identities = defineTable(
      'identities',
      {
        id: pipe(
          number(),
          column({
            physicalType: { postgresql: 'integer' },
            generation: { kind: 'identity', mode: 'byDefault' },
          }),
        ),
        always: pipe(
          number(),
          column({
            physicalType: { postgresql: 'integer' },
            generation: { kind: 'identity', mode: 'always' },
          }),
        ),
      },
      { primaryKey: 'id' },
    )

    const columns = lowerDesiredSchema(
      [Identities],
      postgresIdentities(),
      postgresDialect.schema,
    ).tables[0]!.columns

    expect(columns.find((value) => value.identifier.spelling === 'id')?.generated).toBe(
      'byDefault',
    )

    expect(
      columns.find((value) => value.identifier.spelling === 'always')?.generated,
    ).toBe('always')
  })
}

function registerDesiredSchemaGroup1() {
  afterEach(() => {
    vi.restoreAllMocks()
  })
}

function registerDesiredSchemaGroup2() {
  it('should lower a nullable transformed output to nullable number storage', () => {
    const Transformed = defineTable(
      'nullable_output',
      {
        id: string(),
        value: pipe(
          string(),
          transform((value): number | null => (value === 'null' ? null : Number(value))),
          nullable(number()),
        ),
      },
      { primaryKey: 'id' },
    )

    const tables = lowerDesiredSchema(
      [Transformed],
      postgresIdentities(),
      postgresDialect.schema,
    ).tables

    expect(loweredColumn(tables, 'nullable_output', 'value')).toMatchObject({
      dataType: 'double precision',
      notNull: false,
    })
  })
}

function registerDesiredSchemaGroup3() {
  it('should keep unsafe JSON composite inference as the MigrationError cause', () => {
    const Unsafe = defineTable(
      'unsafe_json_composite',
      { id: string(), value: union([object({ at: date() }), object({ at: date() })]) },
      { primaryKey: 'id' },
    )

    const result = attemptSync(() =>
      lowerDesiredSchema([Unsafe], postgresIdentities(), postgresDialect.schema),
    )

    expect(result.ok).toBe(false)

    if (result.ok) throw new Error('Expected unsafe JSON composite lowering to fail')

    if (!(result.error instanceof MigrationError))
      throw new Error('Expected MigrationError')

    expect(result.error.cause).toBeInstanceOf(SchemaError)

    expect((result.error.cause as SchemaError).message).toContain(
      'JSON composite output is not preserved',
    )
  })
}

function registerDesiredSchemaGroup4() {
  it('should reject an override that cannot carry the output with a SchemaError cause', () => {
    const result = attemptSync(() =>
      lowerDesiredSchema(
        [overriddenDate()],
        postgresIdentities(),
        postgresDialect.schema,
      ),
    )

    if (result.ok) throw new Error('Expected incompatible override lowering to fail')

    if (!(result.error instanceof MigrationError))
      throw new Error('Expected MigrationError')

    expect(result.error.cause).toBeInstanceOf(SchemaError)

    expect((result.error.cause as SchemaError).message).toMatch(
      /PostgreSQL date schema with "text" requires explicit parameter and result mappings/,
    )
  })
}

function registerDesiredSchemaGroup5() {
  it.each<[AnySchema, string]>([
    [pipe(string(), isoDate()), 'timestamptz'],
    [pipe(string(), isoDate()), 'timestamp'],
    [pipe(string(), isoDateTime()), 'timestamptz'],
    [pipe(string(), isoDateTime()), 'date'],
    [pipe(string(), isoTimestamp()), 'timestamp'],
  ])(
    'should lower incompatible ISO temporal storage as MigrationError with SchemaError cause',
    (schema, type) => {
      const Table = defineTable(
        'iso_temporal_override',
        {
          id: string(),
          value: pipe(schema, column({ physicalType: { postgresql: type } })),
        },
        { primaryKey: 'id' },
      )

      const result = attemptSync(() =>
        lowerDesiredSchema([Table], postgresIdentities(), postgresDialect.schema),
      )

      if (result.ok)
        throw new Error('Expected incompatible ISO temporal lowering to fail')

      if (!(result.error instanceof MigrationError))
        throw new Error('Expected MigrationError')

      expect(result.error.cause).toBeInstanceOf(SchemaError)
      expect((result.error.cause as SchemaError).message).toMatch(/ISO output formats/)
    },
  )
}

function registerDesiredSchemaGroup6() {
  it('should lower the same override with paired column hooks', () => {
    const Mapped = overriddenDate({
      mapParam: (value) => (value as Date).toISOString(),
      mapResult: (value) => new Date(String(value)),
    })

    const tables = lowerDesiredSchema(
      [Mapped],
      postgresIdentities(),
      postgresDialect.schema,
    ).tables

    expect(loweredColumn(tables, 'override_storage', 'value')?.dataType).toBe('text')
  })
}

function registerDesiredSchemaGroup7() {
  it('should lower an incompatible ISO override only with paired column hooks', () => {
    const schema = pipe(string(), isoDate())
    const Table = (hooks: {
      mapParam?: (value: unknown) => unknown
      mapResult?: (value: unknown) => unknown
    }) =>
      defineTable(
        'iso_temporal_hooks',
        {
          id: string(),
          value: pipe(
            schema,
            column({ physicalType: { postgresql: 'timestamp(0)' }, ...hooks }),
          ),
        },
        { primaryKey: 'id' },
      )

    expect(() =>
      lowerDesiredSchema(
        [Table({ mapParam: String })],
        postgresIdentities(),
        postgresDialect.schema,
      ),
    ).toThrow(MigrationError)

    const tables = lowerDesiredSchema(
      [
        Table({
          mapParam: (value) => `${String(value)} 00:00:00`,
          mapResult: (value) => String(value).slice(0, 10),
        }),
      ],
      postgresIdentities(),
      postgresDialect.schema,
    ).tables

    expect(loweredColumn(tables, 'iso_temporal_hooks', 'value')?.dataType).toBe(
      'timestamp(0)',
    )
  })
}

function registerDesiredSchemaGroup8() {
  it('should reject the override with only one column hook direction', () => {
    const ParamOnly = overriddenDate({ mapParam: (value) => String(value) })

    const lower = () =>
      lowerDesiredSchema([ParamOnly], postgresIdentities(), postgresDialect.schema)

    expect(lower).toThrow(MigrationError)
    expect(lower).toThrow(/requires explicit parameter and result mappings/)
  })
}

function registerDesiredSchemaGroup9() {
  it('should lower the same override with paired client hooks', () => {
    const graph = registerDesiredSchema([overriddenDate()], postgresIdentities())

    expect(
      loweredColumn(
        postgresDialect.schema.lowerDesiredSchema(graph, {
          hasGlobalParameterMapping: true,
          hasGlobalResultMapping: true,
        }).tables,
        'override_storage',
        'value',
      )?.dataType,
    ).toBe('text')

    const resultOnly = () =>
      postgresDialect.schema.lowerDesiredSchema(graph, { hasGlobalResultMapping: true })

    expect(resultOnly).toThrow(MigrationError)
    expect(resultOnly).toThrow(/requires explicit parameter and result mappings/)
  })
}

function registerDesiredSchemaGroup10() {
  it('should keep rejecting an unsafe override type before checking its storage', () => {
    const Unsafe = defineTable(
      'unsafe_override_storage',
      {
        id: string(),
        value: pipe(
          date(),
          column({ physicalType: { postgresql: 'text; drop table x' } }),
        ),
      },
      { primaryKey: 'id' },
    )

    const result = attemptSync(() =>
      lowerDesiredSchema([Unsafe], postgresIdentities(), postgresDialect.schema),
    )

    if (result.ok) throw new Error('Expected unsafe override lowering to fail')

    if (!(result.error instanceof MigrationError))
      throw new Error('Expected MigrationError')

    expect((result.error.cause as SchemaError).message).toMatch(/unsafe column data type/)
  })
}

function registerDesiredSchemaGroup11() {
  it('should ignore an override selected only for SQLite', () => {
    const SqliteOnly = defineTable(
      'sqlite_only_override',
      { id: string(), value: pipe(date(), column({ physicalType: { sqlite: 'TEXT' } })) },
      { primaryKey: 'id' },
    )

    const tables = lowerDesiredSchema(
      [SqliteOnly],
      postgresIdentities(),
      postgresDialect.schema,
    ).tables

    expect(loweredColumn(tables, 'sqlite_only_override', 'value')?.dataType).toBe(
      'timestamptz',
    )
  })
}

function registerDesiredSchemaGroup12() {
  it('should keep inheriting a text override on a UUID reference target', () => {
    const Parent = defineTable(
      'text_uuid_parent',
      { id: pipe(string(), uuid(), column({ physicalType: { postgresql: 'text' } })) },
      { primaryKey: 'id' },
    )

    const Child = defineTable(
      'text_uuid_child',
      {
        id: string(),
        parentId: pipe(
          reference(Parent, 'id'),
          column({ physicalType: { postgresql: 'text' } }),
        ),
      },
      { primaryKey: 'id' },
    )

    const tables = lowerDesiredSchema(
      [Parent, Child],
      postgresIdentities(),
      postgresDialect.schema,
    ).tables

    expect(loweredColumn(tables, 'text_uuid_child', 'parentId')?.dataType).toBe('text')
  })
}

function registerDesiredSchemaGroup13() {
  describe('PostgreSQL desired schema', () => {
    registerDesiredSchemaCases13()
  })
}

function registerDesiredSchemaGroup14() {
  it.each([undefined, 'numeric'])(
    'should inherit bounded bigint composite storage with PostgreSQL override %s',
    (override) => {
      const { Parent, Child, Grandchild } = nativeReferenceHandles(
        pipe(
          union([bigint(), bigint()]),
          minValue(-(2n ** 63n)),
          maxValue(2n ** 63n - 1n),
          column({
            physicalType: override ? { postgresql: override } : { sqlite: 'BLOB' },
          }),
        ),
      )

      const tables = lowerDesiredSchema(
        [Grandchild, Child, Parent],
        postgresIdentities(),
        postgresDialect.schema,
      ).tables

      const selected = override ?? 'bigint'
      expect(loweredColumn(tables, 'native_parents', 'id')?.dataType).toBe(selected)

      expect(loweredColumn(tables, 'native_children', 'parentId')?.dataType).toBe(
        selected,
      )

      expect(loweredColumn(tables, 'native_children', 'nullableId')).toMatchObject({
        dataType: selected,
        notNull: false,
      })

      expect(loweredColumn(tables, 'native_grandchildren', 'parentId')?.dataType).toBe(
        selected,
      )
    },
  )
}

function registerDesiredSchemaGroup15() {
  it.each([
    [ip(), 'inet'],
    [mac48(), 'macaddr'],
    [mac64(), 'macaddr8'],
    [decimal(), 'numeric'],
  ] as const)(
    'should inherit selected storage for %s through direct, nullable, and chained references',
    (format, nativeType) => {
      for (const override of [undefined, 'text', 'varchar(80)']) {
        const { Parent, Child, Grandchild } = nativeReferenceHandles(
          pipe(
            string(),
            format,
            column({
              physicalType: override ? { postgresql: override } : { sqlite: 'BLOB' },
            }),
          ),
        )

        const tables = lowerDesiredSchema(
          [Grandchild, Child, Parent],
          postgresIdentities(),
          postgresDialect.schema,
        ).tables

        const selected = override ?? nativeType
        expect(loweredColumn(tables, 'native_parents', 'id')?.dataType).toBe(selected)

        expect(loweredColumn(tables, 'native_children', 'parentId')?.dataType).toBe(
          selected,
        )

        expect(loweredColumn(tables, 'native_children', 'nullableId')).toMatchObject({
          dataType: selected,
          notNull: false,
        })

        expect(loweredColumn(tables, 'native_grandchildren', 'parentId')?.dataType).toBe(
          selected,
        )
      }
    },
  )
}

function registerDesiredSchemaGroup16() {
  it('should permit portable conflicts and retain SchemaError as the migration cause', () => {
    const Conflict = defineTable(
      'native_conflict',
      {
        id: pipe(string(), uuid(), ip(), column({ physicalType: { sqlite: 'TEXT' } })),
      },
      { primaryKey: 'id' },
    )

    const result = attemptSync(() =>
      lowerDesiredSchema([Conflict], postgresIdentities(), postgresDialect.schema),
    )

    expect(result.ok).toBe(false)

    if (result.ok) throw new Error('Expected PostgreSQL lowering to fail')

    expect(result.error).toBeInstanceOf(MigrationError)

    if (!(result.error instanceof MigrationError))
      throw new Error('Expected MigrationError')

    expect(result.error.cause).toBeInstanceOf(SchemaError)

    if (!(result.error.cause instanceof SchemaError))
      throw new Error('Expected SchemaError cause')

    expect(result.error.cause.message).toContain('Use one format or column(')
  })
}

function registerDesiredSchemaGroup17() {
  it('should let a selected PostgreSQL override resolve conflicts before inference', () => {
    const Explicit = defineTable(
      'native_explicit',
      {
        id: pipe(
          string(),
          mac48(),
          mac64(),
          column({ physicalType: { postgresql: 'text' } }),
        ),
      },
      { primaryKey: 'id' },
    )

    const tables = lowerDesiredSchema(
      [Explicit],
      postgresIdentities(),
      postgresDialect.schema,
    ).tables

    expect(loweredColumn(tables, 'native_explicit', 'id')?.dataType).toBe('text')
  })
}

function registerDesiredSchemaGroup18() {
  it('should lower inferred choices, selected overrides, and inherited reference storage', () => {
    const Parent = defineTable(
      'choice_parents',
      {
        id: picklist([1, 2]),
        wider: picklist([0, 2147483648]),
        exact: picklist([0n, 2n ** 63n]),
        selected: pipe(
          picklist([1, 2]),
          column({ physicalType: { postgresql: 'integer' } }),
        ),
        unrelated: pipe(picklist([1, 2]), column({ physicalType: { sqlite: 'REAL' } })),
      },
      { primaryKey: 'id' },
    )

    const Child = defineTable(
      'choice_children',
      {
        id: number(),
        parentId: reference(Parent, 'id'),
        nullableId: nullable(reference(Parent, 'id')),
      },
      { primaryKey: 'id' },
    )

    const tables = lowerDesiredSchema(
      [Child, Parent],
      postgresIdentities(),
      postgresDialect.schema,
    ).tables

    expect(loweredColumn(tables, 'choice_parents', 'id')?.dataType).toBe('smallint')
    expect(loweredColumn(tables, 'choice_parents', 'wider')?.dataType).toBe('bigint')
    expect(loweredColumn(tables, 'choice_parents', 'exact')?.dataType).toBe('numeric')
    expect(loweredColumn(tables, 'choice_parents', 'selected')?.dataType).toBe('integer')

    expect(loweredColumn(tables, 'choice_parents', 'unrelated')?.dataType).toBe(
      'smallint',
    )

    expect(loweredColumn(tables, 'choice_children', 'parentId')?.dataType).toBe(
      'smallint',
    )

    expect(loweredColumn(tables, 'choice_children', 'nullableId')).toMatchObject({
      dataType: 'smallint',
      notNull: false,
    })
  })
}

function registerDesiredSchemaGroup19() {
  it('should retain a choice inference SchemaError as the migration cause', () => {
    const Mixed = defineTable(
      'mixed_choices',
      { id: enumSchema({ first: 1, second: 'two' }) },
      { primaryKey: 'id' },
    )

    const result = attemptSync(() =>
      lowerDesiredSchema([Mixed], postgresIdentities(), postgresDialect.schema),
    )

    expect(result.ok).toBe(false)

    if (result.ok) throw new Error('Expected mixed choice lowering to fail')

    expect(result.error).toBeInstanceOf(MigrationError)

    if (!(result.error instanceof MigrationError))
      throw new Error('Expected MigrationError')

    expect(result.error.cause).toBeInstanceOf(SchemaError)

    expect((result.error.cause as SchemaError).message).toContain(
      'column({ physicalType: { postgresql: ... } })',
    )
  })
}

function registerDesiredSchemaGroup20() {
  it('should apply a selected PostgreSQL type before inferring a mixed choice', () => {
    const Mixed = defineTable(
      'mixed_choice_override',
      {
        id: pipe(
          picklist(['one', 1]),
          column({
            physicalType: { postgresql: 'text' },
            mapParam: (value) => String(value),
            mapResult: (value) => (value === '1' ? 1 : 'one'),
          }),
        ),
      },
      { primaryKey: 'id' },
    )

    const tables = lowerDesiredSchema(
      [Mixed],
      postgresIdentities(),
      postgresDialect.schema,
    ).tables

    expect(loweredColumn(tables, 'mixed_choice_override', 'id')?.dataType).toBe('text')

    const Unrelated = defineTable(
      'mixed_choice_unrelated',
      {
        id: pipe(picklist(['one', 1]), column({ physicalType: { sqlite: 'TEXT' } })),
      },
      { primaryKey: 'id' },
    )

    const result = attemptSync(() =>
      lowerDesiredSchema([Unrelated], postgresIdentities(), postgresDialect.schema),
    )

    expect(result.ok).toBe(false)

    if (result.ok) throw new Error('Expected mixed choice lowering to fail')

    expect(result.error).toBeInstanceOf(MigrationError)

    if (!(result.error instanceof MigrationError))
      throw new Error('Expected MigrationError')

    expect(result.error.cause).toBeInstanceOf(SchemaError)
  })
}

function registerDesiredSchemaGroup21() {
  describe('PostgreSQL desired schema', () => {
    registerDesiredSchemaCases21()
  })
}

function registerDesiredSchemaGroup22() {
  describe('PostgreSQL desired schema', () => {
    registerDesiredSchemaCases22()
  })
}

function registerDesiredSchemaGroup23() {
  describe('PostgreSQL desired schema', () => {
    registerDesiredSchemaCases23()
  })
}

function registerDesiredSchemaGroup24() {
  describe('PostgreSQL desired schema', () => {
    registerDesiredSchemaCases24()
  })
}

function registerDesiredSchemaGroup25() {
  describe('PostgreSQL desired schema', () => {
    registerDesiredSchemaCases25()
  })
}

function registerDesiredSchemaGroup26() {
  describe('PostgreSQL desired schema', () => {
    registerDesiredSchemaCases26()
  })
}

function registerDesiredSchemaGroup27() {
  describe('PostgreSQL desired schema', () => {
    registerDesiredSchemaCases27()
  })
}

function registerDesiredSchemaGroup28() {
  describe('PostgreSQL desired schema', () => {
    registerDesiredSchemaCases28()
  })
}

function registerDesiredSchemaGroup29() {
  describe('PostgreSQL desired schema', () => {
    registerDesiredSchemaCases29()
  })
}

function registerDesiredSchemaGroup30() {
  describe('PostgreSQL desired schema', () => {
    registerDesiredSchemaCases30()
  })
}

function registerDesiredSchemaGroup31() {
  describe('PostgreSQL desired schema', () => {
    registerDesiredSchemaCases31()
  })
}

function registerDesiredSchemaGroup32() {
  describe('PostgreSQL desired schema', () => {
    registerDesiredSchemaCases32()
  })
}

function registerDesiredSchemaGroup33() {
  describe('PostgreSQL desired schema', () => {
    registerDesiredSchemaCases33()
  })
}

function registerDesiredSchemaGroup34() {
  describe('PostgreSQL desired schema', () => {
    registerDesiredSchemaCases34()
  })
}

function registerDesiredSchemaGroup35() {
  it('should retain inherited TIME storage and foreign-key metadata with authored second output', () => {
    const Parent = defineTable(
      'temporal_parent',
      { value: pipe(string(), isoTime()) },
      { primaryKey: 'value' },
    )

    const Child = defineTable(
      'temporal_child',
      {
        value: pipe(
          reference(Parent, 'value'),
          transform((value) => `${value}:00`),
          string(),
          isoTimeSecond(),
        ),
      },
      { primaryKey: 'value' },
    )

    const { tables } = lowerDesiredSchema(
      [Child, Parent],
      postgresIdentities(),
      postgresDialect.schema,
    )

    const parent = tables.find((table) => table.handle === Parent)!
    const child = tables.find((table) => table.handle === Child)!
    expect(parent.columns[0]).toMatchObject({ dataType: 'time' })

    expect(child.columns[0]).toMatchObject({
      dataType: 'time',
      reference: { relation: parent.identity, column: identifier('value') },
    })
  })
}

describe('PostgreSQL desired schema', () => {
  registerDesiredSchemaGroup1()
  registerDesiredSchemaGroup2()
  registerDesiredSchemaGroup3()
  registerDesiredSchemaGroup4()
  registerDesiredSchemaGroup5()
  registerDesiredSchemaGroup6()
  registerDesiredSchemaGroup7()
  registerDesiredSchemaGroup8()
  registerDesiredSchemaGroup9()
  registerDesiredSchemaGroup10()
  registerDesiredSchemaGroup11()
  registerDesiredSchemaGroup12()
  registerDesiredSchemaGroup13()
  registerDesiredSchemaGroup14()
  registerDesiredSchemaGroup15()
  registerDesiredSchemaGroup16()
  registerDesiredSchemaGroup17()
  registerDesiredSchemaGroup18()
  registerDesiredSchemaGroup19()
  registerDesiredSchemaGroup20()
  registerDesiredSchemaGroup21()
  registerDesiredSchemaGroup22()
  registerDesiredSchemaGroup23()
  registerDesiredSchemaGroup24()
  registerDesiredSchemaGroup25()
  registerDesiredSchemaGroup26()
  registerDesiredSchemaGroup27()
  registerDesiredSchemaGroup28()
  registerDesiredSchemaGroup29()
  registerDesiredSchemaGroup30()
  registerDesiredSchemaGroup31()
  registerDesiredSchemaGroup32()
  registerDesiredSchemaGroup33()
  registerDesiredSchemaGroup34()
  registerDesiredSchemaGroup35()
})
