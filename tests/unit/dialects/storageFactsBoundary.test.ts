import { expect, it } from 'vitest'

import { postgresDialect, sqliteDialect } from '@/dialects'
import type { AuthoredDesiredSchema } from '@/dialects/types'
import type { StorageFacts } from '@/storage/facts'
import { SchemaError } from '@/utils/error'

const profiles = [
  {
    dialect: postgresDialect,
    dataType: 'boolean',
    stored: true,
    namespace: [
      { role: 'database', spelling: 'test' },
      { role: 'schema', spelling: 'public' },
    ],
  },
  {
    dialect: sqliteDialect,
    dataType: 'BOOLEAN',
    stored: 1,
    namespace: [{ role: 'database', spelling: 'main' }],
  },
] as const

function booleanFacts(): StorageFacts {
  return {
    outputKind: 'boolean',
    outputState: 'known',
    nullable: false,
    allowsUndefined: false,
    outputMayBeUndefined: false,
    omitOnInsert: false,
    schemaDefault: { kind: 'absent' },
    stringConstraints: {},
    stringFormats: [],
    numberConstraints: {},
    bigintConstraints: {},
    nullOnly: false,
  }
}

it.each(profiles)(
  'should make equivalent inference and mapping decisions from facts alone for $dialect.id',
  ({ dialect, dataType, stored }) => {
    const facts = booleanFacts()
    const equivalent = structuredClone(facts)

    expect(dialect.schema.inferColumnType(facts)).toBe(dataType)
    expect(dialect.schema.inferColumnType(equivalent)).toBe(dataType)
    expect(() => dialect.query.validateValueMapping?.(dataType, { facts })).not.toThrow()

    expect(dialect.query.mapParamValue?.(dataType, true, { facts })).toBe(stored)

    expect(dialect.query.mapParamValue?.(dataType, true, { facts: equivalent })).toBe(
      stored,
    )

    expect(dialect.query.mapResultValue?.(dataType, stored, { facts })).toBe(true)

    expect(dialect.query.mapResultValue?.(dataType, stored, { facts: equivalent })).toBe(
      true,
    )
  },
)

it.each(profiles)(
  'should lower equivalent fact-only desired graphs identically for $dialect.id',
  ({ dialect, dataType, namespace }) => {
    const identities = dialect.identity.create({
      context: { writableDefault: namespace },
    })

    const graph: AuthoredDesiredSchema = {
      tables: [
        {
          identity: identities.resolve({ relation: 'flags' }),
          metadata: {
            kind: 'table',
            name: 'flags',
            relation: { relation: 'flags' },
            primaryKey: 'active',
          },
          columns: [
            {
              name: 'active',
              identifier: identities.member('column', 'active'),
              facts: booleanFacts(),
              metadata: {
                kind: 'column',
                databaseDefault: { kind: 'literal', value: true },
              },
            },
          ],
        },
      ],
    }

    const lowered = dialect.schema.lowerDesiredSchema(graph)

    expect(lowered).toEqual(dialect.schema.lowerDesiredSchema(structuredClone(graph)))
    expect(lowered.tables[0]?.columns[0]).toMatchObject({ dataType, notNull: true })

    expect(lowered.tables[0]?.columns[0]?.databaseDefault?.sql).toBe(
      dialect.id === 'postgresql' ? 'true' : '1',
    )
  },
)

it.each(profiles)(
  'should validate locally authored reference facts independently of resolved facts for $dialect.id',
  ({ dialect, dataType }) => {
    const facts = booleanFacts()
    const authoredFacts: StorageFacts = { ...booleanFacts(), outputKind: 'string' }

    expect(() =>
      dialect.query.validateValueMapping?.(dataType, { facts, authoredFacts }),
    ).toThrow(SchemaError)

    expect(() =>
      dialect.query.validateValueMapping?.(dataType, {
        facts,
        authoredFacts: structuredClone(facts),
      }),
    ).not.toThrow()
  },
)
