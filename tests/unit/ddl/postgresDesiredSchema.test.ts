import type {
  MetadataAction,
  NumberSchema,
  ObjectSchema,
  SchemaWithPipe,
  StringSchema,
  TitleAction,
} from 'valibot'
import { nullable, number, pipe, string } from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { lowerDesiredSchema, registerDesiredSchema } from '@/ddl/desiredSchema'
import { postgresDialect } from '@/dialects'
import { POSTGRES_POLICY } from '@/dialects/postgres/identity'
import type { TableMetadata } from '@/index'
import { MigrationError, column, defineTable, reference } from '@/index'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import { validateInsertRow } from '@/query'
import type { TableHandle } from '@/types'

import { relation as canonicalRelation, identifier } from '../helpers/planTargets'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Creates canonical PostgreSQL identities under the fixture's writable namespace default. */
const postgresIdentities = () =>
  createCanonicalRelationIdentityModule({
    policy: POSTGRES_POLICY,
    context: {
      writableDefault: [
        { role: 'database', spelling: 'test' },
        { role: 'schema', spelling: 'public' },
      ],
    },
  })

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

describe('PostgreSQL desired-schema lowering', () => {
  it('lowers every supported metadata and reference form to one fixed schema graph', () => {
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
})

describe('PostgreSQL desired-schema validation', () => {
  it('reports the same first lowering error across column-order permutations', () => {
    /**
     * Lowers ing error for the current fixture scenario.
     *
     * @param table - Table metadata or evidence used to resolve its members.
     *
     * @returns The expected MigrationError; successful lowering fails the test.
     */
    const loweringError = (table: TableHandle): MigrationError => {
      try {
        lowerDesiredSchema([table], postgresIdentities(), postgresDialect.schema)
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationError)
        return error as MigrationError
      }

      throw new Error('Expected desired-schema lowering to fail')
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
})

describe('PostgreSQL desired-schema validation: acknowledges matching local reference types and rejects mismatches', () => {
  it('acknowledges matching local reference types and rejects mismatches', () => {
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
})

describe('PostgreSQL desired-schema default expressions', () => {
  it('distinguishes tagged literals from portable and dialect expressions', () => {
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
})

describe('PostgreSQL desired-schema default expressions: rejects unbalanced or dollar-quoted dialect expressions', () => {
  it('rejects unbalanced or dollar-quoted dialect expressions', () => {
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
})

describe('PostgreSQL desired-schema references and generation', () => {
  it('reports missing direct-lowering reference targets as MigrationError', () => {
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
        tables: graph.tables.filter((table) => table.handle !== Target),
      }),
    ).toThrow(/unregistered relation/i)

    expect(() =>
      postgresDialect.schema.lowerDesiredSchema({
        tables: graph.tables.map((table) =>
          table.handle === Target
            ? {
                ...table,
                columns: table.columns.filter((column) => column.name !== 'id'),
              }
            : table,
        ),
      }),
    ).toThrow(/missing column/i)
  })
})

describe('PostgreSQL desired-schema references and generation: rejects mismatched tags and unsupported generation with MigrationError', () => {
  it('rejects mismatched tags and unsupported generation with MigrationError', () => {
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
})

describe('PostgreSQL desired-schema references and generation: defers comments, onUpdate, and identity type checks to PostgreSQL lowering', () => {
  it('defers comments, onUpdate, and identity type checks to PostgreSQL lowering', () => {
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
})

describe('PostgreSQL desired-schema composed reference metadata', () => {
  it('rejects unsupported local metadata on composed reference columns', () => {
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
})

describe('PostgreSQL desired-schema generation modes', () => {
  it('keeps by-default identity explicitly insertable and always/computed omitted', () => {
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
})

describe('PostgreSQL desired-schema generation modes: lowers identity generation modes', () => {
  it('lowers identity generation modes', () => {
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
})

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
 * @param LegacyMismatch - Table handle used to exercise legacy mismatch schema behavior.
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
