import { nullable, number, pipe, string } from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { lowerDesiredSchema, registerDesiredSchema } from '@/ddl/desiredSchema'
import type { AuthoredDesiredSchema, Dialect } from '@/dialects'
import { postgresDialect } from '@/dialects'
import {
  MigrationError,
  column,
  defineTable,
  getColumnMetadata,
  reference,
} from '@/index'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import type {
  NamespaceContext,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import {
  SQLITE_PHYSICAL_NAMING_FIXTURE,
  createPhysicalNameRegistry,
  generatePhysicalName,
  validatePhysicalName,
} from '@/migrations/physicalNaming'
import { createValueMapper, validateInsertRow } from '@/query'
import type { TableHandle } from '@/types'

afterEach(() => {
  vi.restoreAllMocks()
})

const postgresIdentities = () =>
  createCanonicalRelationIdentityModule({
    adapter: 'postgresql',
    context: {
      writableDefault: [
        { role: 'database', spelling: 'test' },
        { role: 'schema', spelling: 'public' },
      ],
    },
  })

const sqliteIdentities = () =>
  createCanonicalRelationIdentityModule({
    adapter: 'sqlite',
    context: { writableDefault: [{ role: 'database', spelling: 'main' }] },
  })

function identityKey(
  identity: AuthoredDesiredSchema['tables'][number]['identity'],
): string {
  return JSON.stringify([
    ...identity.namespace.map((segment) => [
      segment.role,
      segment.identifier.comparisonKey,
    ]),
    ['relation', identity.relation.comparisonKey],
  ])
}

function fakeSqliteDialect(): Dialect {
  const identity = {
    create(options: {
      context: NamespaceContext
      registrationDefault?: readonly NamespaceIdentifierInput[]
    }) {
      return createCanonicalRelationIdentityModule({ adapter: 'sqlite', ...options })
    },
  }

  const naming = {
    generate: (seed: Parameters<typeof generatePhysicalName>[0]) =>
      generatePhysicalName(seed, SQLITE_PHYSICAL_NAMING_FIXTURE),
    validate: (name: string, description: string) =>
      validatePhysicalName(name, description, SQLITE_PHYSICAL_NAMING_FIXTURE),
    createRegistry: () => createPhysicalNameRegistry(SQLITE_PHYSICAL_NAMING_FIXTURE),
  }

  const lowerDesiredSchema = (graph: AuthoredDesiredSchema) => {
    const types = new Map<string, string>()

    for (const table of graph.tables) {
      for (const authored of table.columns) {
        if (authored.reference) continue
        const selected = authored.metadata?.physicalType?.sqlite

        if (!selected) {
          throw new MigrationError({
            message: `fake SQLite requires a sqlite physical type for ${authored.name}`,
          })
        }

        types.set(`${identityKey(table.identity)}\0${authored.name}`, selected)
      }
    }

    return {
      tables: graph.tables.map((table) => ({
        handle: table.handle,
        identity: table.identity,
        ast: {
          kind: 'create_table' as const,
          table: table.metadata.name,
          columns: table.columns.map((authored) => {
            const dataType = authored.reference
              ? types.get(
                  `${identityKey(authored.reference.targetRelation)}\0${authored.reference.targetColumn}`,
                )
              : types.get(`${identityKey(table.identity)}\0${authored.name}`)

            if (dataType === undefined) {
              throw new MigrationError({
                message: `fake SQLite requires a resolved physical type for ${authored.name}`,
              })
            }

            return {
              name: authored.name,
              dataType,
              notNull: true,
              unique: authored.metadata?.unique ?? false,
              autoIncrement: false,
            }
          }),
          primaryKey: Array.isArray(table.metadata.primaryKey)
            ? table.metadata.primaryKey
            : [table.metadata.primaryKey],
        },
      })),
    }
  }

  const inferColumnType = vi.fn(() => {
    throw new Error('fake adapter inference must not be used by this contract')
  })
  const normalizeDataType = vi.fn((value: string) => value)
  const compile = vi.fn(() => ({ sql: '', params: [] }))
  const catalog = {
    introspectCatalog: vi.fn(async () => {
      throw new Error('fake adapter introspection is outside this contract')
    }),
  }

  return {
    id: 'sqlite',
    identity,
    naming,
    schema: {
      lowerDesiredSchema,
      inferColumnType,
      normalizeDataType,
    },
    query: { compile },
    catalog,
    operations: {
      createSessionProvider: () => {
        throw new Error('fake SQLite operations are outside this contract')
      },
    },
    migration: {
      lower: () => {
        throw new Error('fake SQLite migration is outside this contract')
      },
      execute: async () => {
        throw new Error('fake SQLite migration is outside this contract')
      },
    },
    // This fake is intentionally non-production; these aliases preserve the
    // transitional Dialect paths exercised by the desired-schema tests.
    relationIdentity: 'sqlite',
    lowerDesiredSchema,
    inferColumnType,
    normalizeDataType,
    compile,
  }
}

describe('whole-graph desired-schema lowering', () => {
  it('binds SQLite identity semantics behind the test dialect facet', () => {
    const identity = fakeSqliteDialect().identity.create({
      context: { writableDefault: [{ role: 'database', spelling: 'main' }] },
    })
    const resolved = identity.resolve({ relation: 'Users' })

    expect(resolved.namespace[0]?.identifier.spelling).toBe('main')
    expect(resolved.relation.comparisonKey).toBe('users')
  })

  it('inherits the selected adapter target type without PostgreSQL leakage', () => {
    const Parent = defineTable(
      'parents',
      {
        id: pipe(
          string(),
          column({
            physicalType: {
              postgresql: 'uuid',
              sqlite: 'blob_id',
              mysql: 'binary(16)',
            },
          }),
        ),
        label: pipe(
          string(),
          column({ physicalType: { postgresql: 'text', sqlite: 'sqlite_text' } }),
        ),
      },
      { primaryKey: 'id' },
    )
    const Child = defineTable(
      'children',
      {
        id: pipe(
          string(),
          column({ physicalType: { postgresql: 'uuid', sqlite: 'blob_id' } }),
        ),
        parentId: reference(Parent, 'id'),
      },
      { primaryKey: 'id' },
    )

    const inferSpy = vi.spyOn(postgresDialect, 'inferColumnType')
    const normalizeSpy = vi.spyOn(postgresDialect, 'normalizeDataType')
    const compileSpy = vi.spyOn(postgresDialect, 'compile')
    const fake = fakeSqliteDialect()
    expect(getColumnMetadata(Child.getSchema().entries.parentId)).toBeUndefined()
    const sqlite = lowerDesiredSchema([Child, Parent], sqliteIdentities(), fake)

    const sqliteParent = sqlite.tables.find((table) => table.ast.table === 'parents')!
    const sqliteChild = sqlite.tables.find((table) => table.ast.table === 'children')!
    expect(
      sqliteParent.ast.columns.find((column) => column.name === 'id')?.dataType,
    ).toBe('blob_id')
    expect(
      sqliteChild.ast.columns.find((column) => column.name === 'parentId')?.dataType,
    ).toBe('blob_id')
    expect(inferSpy).not.toHaveBeenCalled()
    expect(normalizeSpy).not.toHaveBeenCalled()
    expect(compileSpy).not.toHaveBeenCalled()
    expect(
      createValueMapper(fake, undefined, [Child, Parent]).columnTypes(Child),
    ).toMatchObject({ parentId: 'blob_id' })

    const postgres = lowerDesiredSchema(
      [Parent, Child],
      postgresIdentities(),
      postgresDialect,
    )
    const postgresChild = postgres.tables.find((table) => table.ast.table === 'children')!
    expect(
      postgresChild.ast.columns.find((column) => column.name === 'parentId')?.dataType,
    ).toBe('uuid')
  })

  it('rejects dangling and non-candidate reference targets before planning', () => {
    const Composite = defineTable(
      'composite',
      {
        tenantId: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        memberId: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      },
      { primaryKey: ['tenantId', 'memberId'] },
    )
    const Ref = defineTable(
      'refs',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        memberId: reference(Composite, 'memberId'),
      },
      { primaryKey: 'id' },
    )

    expect(() =>
      lowerDesiredSchema([Ref], postgresIdentities(), postgresDialect),
    ).toThrow(/unregistered relation/i)
    expect(() =>
      lowerDesiredSchema([Composite, Ref], postgresIdentities(), postgresDialect),
    ).toThrow(/not a candidate key/i)
  })

  it('accepts table cycles when reference targets have ordinary physical types', () => {
    const InitialA = defineTable(
      'a',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const B = defineTable(
      'b',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        aId: reference(InitialA, 'id'),
      },
      { primaryKey: 'id' },
    )
    const A = defineTable(
      'a',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        bId: reference(B, 'id'),
      },
      { primaryKey: 'id' },
    )

    expect(() =>
      lowerDesiredSchema([B, A], postgresIdentities(), postgresDialect),
    ).not.toThrow()
  })

  it('resolves reference chains and reports reference-only cycles deterministically', () => {
    const Root = defineTable(
      'root',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const Middle = defineTable(
      'middle',
      { id: reference(Root, 'id') },
      { primaryKey: 'id' },
    )
    const Leaf = defineTable(
      'leaf',
      { id: reference(Middle, 'id') },
      { primaryKey: 'id' },
    )
    const lowered = lowerDesiredSchema(
      [Leaf, Middle, Root],
      postgresIdentities(),
      postgresDialect,
    )
    expect(
      lowered.tables
        .find((table) => table.ast.table === 'leaf')!
        .ast.columns.find((value) => value.name === 'id')?.dataType,
    ).toBe('uuid')

    const InitialB = defineTable(
      'cycle_b',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const CycleA = defineTable(
      'cycle_a',
      { id: reference(InitialB, 'id') },
      { primaryKey: 'id' },
    )
    const CycleB = defineTable(
      'cycle_b',
      { id: reference(CycleA, 'id') },
      { primaryKey: 'id' },
    )
    expect(() =>
      lowerDesiredSchema([CycleB, CycleA], postgresIdentities(), postgresDialect),
    ).toThrow(/reference-only physical type cycle.*cycle_a/i)
  })

  it('accepts an independent single-column unique index as a candidate key', () => {
    const Target = defineTable(
      'indexed_target',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        code: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
      },
      { primaryKey: 'id', indexes: [{ columns: ['code'], unique: true }] },
    )
    const Source = defineTable(
      'indexed_source',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        code: reference(Target, 'code'),
      },
      { primaryKey: 'id' },
    )

    expect(() =>
      lowerDesiredSchema([Source, Target], postgresIdentities(), postgresDialect),
    ).not.toThrow()
  })

  it('preserves unique on a composite-primary-key member only when independently set', () => {
    const Membership = defineTable(
      'memberships',
      {
        tenantId: pipe(
          string(),
          column({ physicalType: { postgresql: 'uuid' }, unique: true }),
        ),
        memberId: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      },
      { primaryKey: ['tenantId', 'memberId'] },
    )
    const [table] = lowerDesiredSchema(
      [Membership],
      postgresIdentities(),
      postgresDialect,
    ).tables

    expect(table!.ast.columns.find((value) => value.name === 'tenantId')?.unique).toBe(
      true,
    )
  })

  it('lowers composed reference metadata without copying target column options', () => {
    const Target = defineTable(
      'composed_targets',
      {
        id: pipe(
          string(),
          column({
            physicalType: { postgresql: 'uuid' },
            databaseDefault: {
              kind: 'dialectExpression',
              dialect: 'postgresql',
              expression: 'gen_random_uuid()',
            },
          }),
        ),
      },
      { primaryKey: 'id' },
    )
    const Source = defineTable(
      'composed_sources',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        targetId: pipe(
          reference(Target, 'id', { onDelete: 'set default' }),
          column({
            unique: true,
            databaseDefault: {
              kind: 'literal',
              value: '00000000-0000-0000-0000-000000000000',
            },
          }),
        ),
        nullableTargetId: nullable(
          pipe(reference(Target, 'id'), column({ unique: true })),
        ),
        plainTargetId: reference(Target, 'id'),
      },
      { primaryKey: 'id' },
    )
    const source = lowerDesiredSchema(
      [Source, Target],
      postgresIdentities(),
      postgresDialect,
    ).tables.find((table) => table.ast.table === 'composed_sources')!
    const targetId = source.ast.columns.find((value) => value.name === 'targetId')!
    const nullableTargetId = source.ast.columns.find(
      (value) => value.name === 'nullableTargetId',
    )!
    const plainTargetId = source.ast.columns.find(
      (value) => value.name === 'plainTargetId',
    )!

    expect(targetId).toMatchObject({
      dataType: 'uuid',
      unique: true,
      references: {
        table: 'composed_targets',
        column: 'id',
        onDelete: 'set default',
      },
      databaseDefault: {
        sql: "'00000000-0000-0000-0000-000000000000'",
      },
    })
    expect(nullableTargetId).toMatchObject({
      dataType: 'uuid',
      notNull: false,
      unique: true,
      references: { table: 'composed_targets', column: 'id' },
    })
    expect(plainTargetId.references).toMatchObject({
      table: 'composed_targets',
      column: 'id',
    })
    expect(plainTargetId).not.toHaveProperty('defaultValue')
    expect(plainTargetId).not.toHaveProperty('databaseDefault')
  })

  it('maps reference values with the target type and local mapping functions', () => {
    const Target = defineTable(
      'mapped_targets',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const Source = defineTable(
      'mapped_sources',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        targetId: pipe(
          reference(Target, 'id'),
          column({
            mapParam: (value) => `param:${String(value)}`,
            mapResult: (value) => `result:${String(value)}`,
          }),
        ),
      },
      { primaryKey: 'id' },
    )
    const mapper = createValueMapper(postgresDialect, undefined, [Source, Target])

    expect(mapper.columnTypes(Source).targetId).toBe('uuid')
    expect(mapper.mapParam(Source, 'targetId', 'abc')).toBe('param:abc')
    expect(mapper.mapResultValue(Source, 'targetId', 'abc')).toBe('result:abc')
  })

  it('validates reference targets before global or dialect mapping', () => {
    const Target = defineTable(
      'mapper_targets',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const Source = defineTable(
      'mapper_sources',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        targetId: reference(Target, 'id'),
      },
      { primaryKey: 'id' },
    )

    expect(() => createValueMapper(postgresDialect, undefined, [Source])).toThrow(
      /not registered/i,
    )

    const globalMap = vi.fn((_dataType: string, value: unknown) => `global:${value}`)
    const globalMapper = createValueMapper(
      postgresDialect,
      { mapParamValue: globalMap },
      [Source, Target],
    )
    expect(globalMapper.mapParam(Source, 'targetId', 'abc')).toBe('global:abc')
    expect(globalMap).toHaveBeenCalledWith('uuid', 'abc')

    const dialectMap = vi.fn((_dataType: string, value: unknown) => `dialect:${value}`)
    const dialectMapper = createValueMapper(
      { ...postgresDialect, mapParamValue: dialectMap },
      undefined,
      [Source, Target],
    )
    expect(dialectMapper.mapParam(Source, 'targetId', 'abc')).toBe('dialect:abc')
    expect(dialectMap).toHaveBeenCalledWith('uuid', 'abc')
  })
})

describe('PostgreSQL desired-schema lowering', () => {
  it('reports the same first lowering error across column-order permutations', () => {
    const loweringError = (table: TableHandle): MigrationError => {
      try {
        lowerDesiredSchema([table], postgresIdentities(), postgresDialect)
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationError)
        return error as MigrationError
      }

      throw new Error('Expected desired-schema lowering to fail')
    }

    const PhysicalForward = defineTable(
      'deterministic_physical',
      {
        zeta: pipe(
          string(),
          column({ physicalType: { postgresql: 'unsupported_zeta' } }),
        ),
        alpha: pipe(
          string(),
          column({ physicalType: { postgresql: 'unsupported_alpha' } }),
        ),
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      },
      { primaryKey: 'id' },
    )
    const PhysicalReverse = defineTable(
      'deterministic_physical',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        alpha: pipe(
          string(),
          column({ physicalType: { postgresql: 'unsupported_alpha' } }),
        ),
        zeta: pipe(
          string(),
          column({ physicalType: { postgresql: 'unsupported_zeta' } }),
        ),
      },
      { primaryKey: 'id' },
    )
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
    const CapabilityForward = defineTable(
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
    const CapabilityReverse = defineTable(
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
    const capabilityForward = loweringError(CapabilityForward)
    const capabilityReverse = loweringError(CapabilityReverse)
    expect(capabilityForward.message).toBe(capabilityReverse.message)
    expect(capabilityForward.message).toMatch(/finite/)
  })

  it('acknowledges matching local reference types and rejects mismatches', () => {
    const Target = defineTable(
      'typed_targets',
      { id: pipe(number(), column({ physicalType: { postgresql: 'integer' } })) },
      { primaryKey: 'id' },
    )
    const Matching = defineTable(
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
    const matching = lowerDesiredSchema(
      [Matching, Target],
      postgresIdentities(),
      postgresDialect,
    ).tables.find((table) => table.ast.table === 'matching_refs')!
    expect(
      matching.ast.columns
        .filter((value) => value.name !== 'id')
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

    for (const source of [LegacyMismatch, SelectedMismatch]) {
      expect(() =>
        lowerDesiredSchema([source, Target], postgresIdentities(), postgresDialect),
      ).toThrow(MigrationError)
      expect(() =>
        lowerDesiredSchema([source, Target], postgresIdentities(), postgresDialect),
      ).toThrow(/selects PostgreSQL type.*target type/i)
    }
  })

  it('distinguishes tagged literals from portable and dialect expressions', () => {
    const Defaults = defineTable(
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
    const table = lowerDesiredSchema([Defaults], postgresIdentities(), postgresDialect)
      .tables[0]!
    const sql = postgresDialect.compile(table.ast).sql

    expect(sql).toContain(`default 'now()'`)
    expect(sql).toContain("default E'C:\\\\O''Brien\\\\'")
    expect(sql).toContain('default current_timestamp')
    expect(sql).toContain('default now()')
  })

  it('rejects unbalanced or dollar-quoted dialect expressions', () => {
    for (const expression of [
      "'unterminated",
      '(now()',
      ')now()(',
      '$$now()$$',
      '$tag$now()$tag$',
    ]) {
      const Invalid = defineTable(
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
      expect(() =>
        lowerDesiredSchema([Invalid], postgresIdentities(), postgresDialect),
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
      lowerDesiredSchema([Valid], postgresIdentities(), postgresDialect),
    ).not.toThrow()
  })

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
      postgresDialect.lowerDesiredSchema({
        tables: graph.tables.filter((table) => table.handle !== Target),
      }),
    ).toThrow(/unregistered relation/i)

    expect(() =>
      postgresDialect.lowerDesiredSchema({
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

    for (const table of [Mismatched, Computed]) {
      expect(() =>
        lowerDesiredSchema([table], postgresIdentities(), postgresDialect),
      ).toThrow(MigrationError)
    }
  })

  it('defers comments, onUpdate, and identity type checks to PostgreSQL lowering', () => {
    const BadIdentity = defineTable(
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
        lowerDesiredSchema([table], postgresIdentities(), postgresDialect),
      ).toThrow(MigrationError)
      expect(() =>
        lowerDesiredSchema([table], postgresIdentities(), postgresDialect),
      ).toThrow(message)
    }
  })

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
    const Computed = defineTable(
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

    for (const [source, message] of [
      [Commented, /comments/i],
      [Updated, /onUpdate/i],
      [Computed, /computed generation/i],
    ] as const) {
      expect(() =>
        lowerDesiredSchema([source, Target], postgresIdentities(), postgresDialect),
      ).toThrow(MigrationError)
      expect(() =>
        lowerDesiredSchema([source, Target], postgresIdentities(), postgresDialect),
      ).toThrow(message)
    }
  })

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
      postgresDialect,
    ).tables[0]!.ast.columns

    expect(columns.find((value) => value.name === 'id')?.generated).toBe('byDefault')
    expect(columns.find((value) => value.name === 'always')?.generated).toBe('always')
  })
})
