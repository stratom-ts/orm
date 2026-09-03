import type { Connector } from 'db0'
import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { planMigration } from '@/ddl/migrationPlan'
import type { CatalogSnapshot } from '@/dialects/catalog'
import { registerDialectForTest } from '@/dialects/resolve'
import type { Dialect, OperationCommand } from '@/dialects/types'
import { QueryError, column, createDatabase, defineTable, eq, reference } from '@/index'
import type { NamespaceIdentifierInput } from '@/migrations/canonicalRelationIdentity'
import { createCatalogRequest } from '@/migrations/migrationOwnership'
import { createValueMapper } from '@/query'

export type DialectMemberContractRuntime = Readonly<{
  dialect: Dialect
  connector: Connector
  events: string[]
  operationCommands: OperationCommand[]
  statements: Array<{ sql: string; params: unknown[] }>
  catalog(): CatalogSnapshot | undefined
  selectedConnector(): Connector | undefined
  disposed(): boolean
  directConnectorMethods: readonly (() => unknown)[]
  expected: Readonly<{
    queryRows: readonly unknown[]
    querySql: string
    queryParam: unknown
    pingSql: string
    forbiddenSql?: RegExp
    memberComparison: 'caseFolded' | 'caseSensitive'
    registrationDefault: readonly NamespaceIdentifierInput[]
  }>
  migration:
    | Readonly<{ state: 'supported'; outcomes: Array<'applied' | 'unchanged'> }>
    | Readonly<{ state: 'unsupported'; reason: string }>
}>

export type DialectMemberContractFactory = () => DialectMemberContractRuntime

/** Asserts that compiled addressing, parameters, provider rows, and result mapping agree. */
export function assertDialectQueryAgreement(
  runtime: DialectMemberContractRuntime,
  rows: readonly unknown[],
): void {
  expect(rows).toEqual(runtime.expected.queryRows)
  expect(
    runtime.statements.find(({ sql }) => sql === runtime.expected.querySql)?.params,
  ).toEqual([runtime.expected.queryParam])
}

function expectExplicitCapabilityEvidence(catalog: CatalogSnapshot): void {
  for (const capability of Object.values(catalog.capabilities)) {
    if (capability.state === 'supported') continue

    expect(capability.state).toMatch(/unsupported|unavailable/)
    if ('reason' in capability) expect(capability.reason.length).toBeGreaterThan(0)

    if (capability.state === 'unavailable' && capability.cause === 'version') {
      expect(capability.actual.length).toBeGreaterThan(0)
      expect(capability.requires.length).toBeGreaterThan(0)
    }
  }
}

/**
 * Registers the observable contract shared by complete connector-selected members.
 *
 * A runtime exposes semantic observations, not database-specific SQL assertions. An
 * adapter may advertise migration as unsupported; catalog gaps must still carry tagged
 * evidence.
 */
export function registerDialectMemberContract(
  name: string,
  createRuntime: DialectMemberContractFactory,
): void {
  describe(`${name} Dialect member contract`, () => {
    it('routes the complete database lifecycle through the connector-selected member', async () => {
      const runtime = createRuntime()
      const unregister = registerDialectForTest(runtime.dialect)
      const Records = defineTable(
        'records',
        {
          id: pipe(
            string(),
            column({ physicalType: { [runtime.dialect.id]: 'fixture_id' } }),
          ),
          label: string(),
        },
        { primaryKey: 'id' },
      )
      let closeDatabase: (() => Promise<void>) | undefined

      try {
        const db = createDatabase({
          connector: runtime.connector,
          schemas: [Records],
          defaultNamespace: runtime.expected.registrationDefault,
        })
        closeDatabase = () => db.close()
        await db.ping()
        const rows = await db
          .from(Records)
          .where(Records.label, 'eq', 'authored-value')
          .execute()

        assertDialectQueryAgreement(runtime, rows)

        await db.transaction(async (transaction) => {
          await transaction.ping()
          await transaction.transaction(async (nested) => nested.ping())
          await expect(
            transaction.transaction(async () => {
              throw new Error('nested contract rollback')
            }),
          ).rejects.toThrow('nested contract rollback')
        })
        await expect(
          db.transaction(async () => {
            throw new Error('root contract rollback')
          }),
        ).rejects.toThrow('root contract rollback')

        const dryRun = await db.migrate().dryRun()
        expect(dryRun.steps.length).toBeGreaterThan(0)

        if (runtime.migration.state === 'supported') {
          await db.migrate().execute()
        } else {
          const error = await db
            .migrate()
            .execute()
            .catch((cause: unknown) => cause)
          expect(error).toMatchObject({
            _tag: 'MigrationError',
            stage: 'lowering',
            outcome: 'unchanged',
            retryable: false,
            sourceStepIndexes: dryRun.steps.map((_step, index) => index),
            capabilityIssues: [
              {
                code: 'compile_failure',
                message: runtime.migration.reason,
                sourceStepIndexes: dryRun.steps.map((_step, index) => index),
              },
            ],
          })
          expect(
            runtime.statements.some(({ sql }) => /fixture migration/i.test(sql)),
          ).toBe(false)
        }

        await db.close()

        expect(runtime.selectedConnector()).toBe(runtime.connector)
        expect(runtime.events).toEqual(
          expect.arrayContaining([
            'operations.createSessionProvider',
            'identity.create',
            'naming.generate',
            'naming.validate',
            'naming.createRegistry',
            'schema.lowerDesiredSchema',
            'schema.inferColumnType',
            'query.resolve',
            'query.compile',
            'query.mapParamValue',
            'query.mapResultValue',
            'catalog.introspect',
            'migration.execute',
            'session.open',
            'session.release:reuse',
            'sessionProvider.close',
          ]),
        )
        expect(runtime.events.filter((event) => event === 'query.resolve')).toHaveLength(
          1,
        )

        if (runtime.migration.state === 'supported') {
          expect(runtime.events).toEqual(
            expect.arrayContaining([
              'catalog.introspect',
              'migration.execute',
              'migration.lower',
              'migration.prepared',
            ]),
          )
        }

        expect(runtime.operationCommands).toEqual(
          expect.arrayContaining([
            { kind: 'ping' },
            { kind: 'begin' },
            { kind: 'commit' },
            { kind: 'rollback' },
            { kind: 'createSavepoint', id: 1 },
            { kind: 'releaseSavepoint', id: 1 },
            { kind: 'rollbackToSavepoint', id: 2 },
            { kind: 'releaseSavepoint', id: 2 },
          ]),
        )
        const catalog = runtime.catalog()
        expect(catalog).toBeDefined()
        expectExplicitCapabilityEvidence(catalog!)

        const forbiddenSql = runtime.expected.forbiddenSql

        if (forbiddenSql) {
          expect(runtime.statements.some(({ sql }) => forbiddenSql.test(sql))).toBe(false)
        }

        expect(runtime.disposed()).toBe(true)

        for (const method of runtime.directConnectorMethods) {
          expect(method).not.toHaveBeenCalled()
        }
      } finally {
        try {
          await closeDatabase?.()
        } finally {
          unregister()
        }
      }
    })

    it('keeps an explicit session provider execution-only', async () => {
      const runtime = createRuntime()
      const unregister = registerDialectForTest(runtime.dialect)
      const overrideStatements: string[] = []
      const provider = {
        nativeTransactions: true as const,
        async open() {
          return {
            identity: { database: 'override_db', physicalSession: 'override-session' },
            async query(query: { sql: string }) {
              overrideStatements.push(query.sql)
              return []
            },
            async run(query: { sql: string }) {
              overrideStatements.push(query.sql)
            },
            async cancel() {},
            async release() {},
          }
        },
        async close() {},
      }
      let closeDatabase: (() => Promise<void>) | undefined

      try {
        const db = createDatabase({
          connector: runtime.connector,
          operationSessionProvider: provider,
          schemas: [],
        })
        closeDatabase = () => db.close()
        await db.ping()
        await db.close()

        expect(overrideStatements).toEqual([runtime.expected.pingSql])
        expect(runtime.operationCommands).toContainEqual({ kind: 'ping' })
        expect(runtime.events).not.toContain('operations.createSessionProvider')
      } finally {
        try {
          await closeDatabase?.()
        } finally {
          unregister()
        }
      }
    })

    it('rejects every mismatched Semantic Profile field before physical lowering', async () => {
      const runtime = createRuntime()
      const Records = defineTable(
        'profile_records',
        {
          id: pipe(
            string(),
            column({ physicalType: { [runtime.dialect.id]: 'fixture_id' } }),
          ),
        },
        { primaryKey: 'id' },
      )
      const request = createCatalogRequest([Records], [])
      const catalog = await runtime.dialect.catalog.introspectCatalog(
        { execute: async () => [] },
        request,
      )
      const planned = planMigration(
        [Records],
        catalog,
        runtime.dialect.migration.planning,
      )
      const expected = {
        identityAdapter: runtime.dialect.identity.id,
        namespaceContext: catalog.namespaceContext,
      }
      const profiles = [
        { ...expected, identityAdapter: `${runtime.dialect.identity.id}-other` },
        {
          ...expected,
          namespaceContext: {
            writableDefault: [{ role: 'database' as const, spelling: 'other_db' }],
          },
        },
        {
          ...expected,
          registrationDefault: [
            { role: 'database' as const, spelling: 'other_registration' },
          ],
        },
        {
          ...expected,
          registrationDefault: catalog.namespaceContext.writableDefault,
        },
      ]

      for (const profile of profiles) {
        const result = runtime.dialect.migration.lower(planned, profile)
        expect(result.program).toBeUndefined()
        expect(result.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'profile_mismatch',
              sourceStepIndexes: [],
            }),
          ]),
        )
      }

      expect(runtime.statements.some(({ sql }) => /fixture migration/i.test(sql))).toBe(
        false,
      )
      await runtime.connector.dispose?.()
    })

    it('reconciles case-folded members and preserves structured database references', () => {
      const runtime = createRuntime()
      if (runtime.expected.memberComparison !== 'caseFolded') return
      const namespace = [{ role: 'database' as const, spelling: 'fixture_db' }]
      const Parents = defineTable(
        'contract_parents',
        {
          id: pipe(
            string(),
            column({ physicalType: { [runtime.dialect.id]: 'fixture_text' } }),
          ),
        },
        { primaryKey: 'id', namespace },
      )
      const Children = defineTable(
        'contract_children',
        {
          id: pipe(
            string(),
            column({ physicalType: { [runtime.dialect.id]: 'fixture_text' } }),
          ),
          parentId: reference(Parents, 'id'),
          code: pipe(
            string(),
            column({
              physicalType: { [runtime.dialect.id]: 'fixture_text' },
              unique: true,
            }),
          ),
        },
        {
          primaryKey: 'id',
          namespace,
          indexes: [
            { name: 'children_code_idx', columns: ['code'] },
            { columns: ['parentId'] },
          ],
        },
      )
      const schemas = [Parents, Children]
      const namespaceContext = { writableDefault: namespace }
      const identities = runtime.dialect.identity.create({ context: namespaceContext })
      const parent = identities.resolve(Parents.getTableMetadata().relation)
      const child = identities.resolve(Children.getTableMetadata().relation)
      const request = createCatalogRequest(schemas, [])
      const resolvedRequest = {
        relations: request.relations.map((entry) => ({
          identity: identities.resolve(entry.relation),
          shape: entry.shape,
        })),
        absentRelations: request.absentRelations.map((entry) =>
          identities.resolve(entry),
        ),
        completeNamespaces: request.completeNamespaces.map((entry) =>
          identities.resolveNamespace(entry),
        ),
      }
      const absent = { state: 'absent' as const }
      const present = <T>(value: T) => ({ state: 'present' as const, value })
      const complete = { state: 'complete' as const }
      const semantics = present({ kind: 'simple' as const })
      const validity = present('valid' as const)
      const catalogColumn = (name: string, position: number) => ({
        name,
        position,
        dataType: present({
          native: 'fixture_text',
          comparisonKey: 'fixture_text',
          family: 'text',
          parameters: [],
          userDefined: absent,
        }),
        nullable: present(false),
        default: absent,
        generation: absent,
        nativeDefinition: absent,
      })
      const key = (name: string, columns: readonly string[]) => ({
        name: present(name),
        columns,
        semantics,
        validity,
        nativeDefinition: absent,
      })
      const generatedIndex = runtime.dialect.naming.generate({
        kind: 'index',
        owner: child,
        columns: ['parentId'],
        unique: false,
      })
      const table = (
        columns: ReturnType<typeof catalogColumn>[],
        primaryKey: ReturnType<typeof key>,
        options?: {
          uniqueConstraints?: ReturnType<typeof key>[]
          foreignKeys?: Array<
            ReturnType<typeof key> & {
              referencedRelation: typeof parent
              referencedColumns: readonly string[]
              onDelete: 'no action'
              onUpdate: 'no action'
            }
          >
          indexes?: Array<{
            name: ReturnType<typeof present<string>>
            origin: 'user'
            columns: readonly string[]
            unique: boolean
            semantics: typeof semantics
            validity: typeof validity
            nativeDefinition: typeof absent
          }>
        },
      ) => ({
        columns: { items: columns, coverage: complete },
        primaryKey: present(primaryKey),
        uniqueConstraints: {
          items: options?.uniqueConstraints ?? [],
          coverage: complete,
        },
        foreignKeys: { items: options?.foreignKeys ?? [], coverage: complete },
        indexes: { items: options?.indexes ?? [], coverage: complete },
        options: { items: [], coverage: complete },
        opaqueObjects: { items: [], coverage: complete },
      })
      const snapshot = (
        withRelations: boolean,
        duplicates?: {
          columns?: readonly string[]
          indexes?: readonly string[]
        },
      ): CatalogSnapshot => ({
        source: { dialect: runtime.dialect.id, version: 'contract-case-folding' },
        request: resolvedRequest,
        capabilities: {
          namespaces: { state: 'supported', fidelity: 'portable' },
          relationOwner: { state: 'supported', fidelity: 'portable' },
          identity: { state: 'supported', fidelity: 'portable' },
          richObjects: { state: 'supported', fidelity: 'portable' },
        },
        namespaceContext,
        namespaces: {
          items: withRelations
            ? [
                {
                  identity: parent.namespace,
                  owner: absent,
                  relations: {
                    coverage: complete,
                    items: [
                      {
                        identity: parent,
                        kind: 'table',
                        persistence: 'permanent',
                        owner: absent,
                        management: 'managed',
                        nativeDefinition: absent,
                        table: present(
                          table(
                            [
                              catalogColumn('ID', 1),
                              ...(duplicates?.columns ?? []).map((name, index) =>
                                catalogColumn(name, index + 2),
                              ),
                            ],
                            key('PARENTS_PK', ['ID']),
                          ),
                        ),
                      },
                      {
                        identity: child,
                        kind: 'table',
                        persistence: 'permanent',
                        owner: absent,
                        management: 'managed',
                        nativeDefinition: absent,
                        table: present(
                          table(
                            [
                              catalogColumn('ID', 1),
                              catalogColumn('PARENTID', 2),
                              catalogColumn('CODE', 3),
                            ],
                            key('CHILDREN_PK', ['ID']),
                            {
                              uniqueConstraints: [key('CHILDREN_CODE_KEY', ['CODE'])],
                              foreignKeys: [
                                {
                                  ...key('CHILDREN_PARENT_FK', ['PARENTID']),
                                  referencedRelation: parent,
                                  referencedColumns: ['ID'],
                                  onDelete: 'no action',
                                  onUpdate: 'no action',
                                },
                              ],
                              indexes: [
                                {
                                  name: present('CHILDREN_CODE_IDX'),
                                  origin: 'user',
                                  columns: ['CODE'],
                                  unique: false,
                                  semantics,
                                  validity,
                                  nativeDefinition: absent,
                                },
                                {
                                  name: present(generatedIndex.toUpperCase()),
                                  origin: 'user',
                                  columns: ['PARENTID'],
                                  unique: false,
                                  semantics,
                                  validity,
                                  nativeDefinition: absent,
                                },
                                ...(duplicates?.indexes ?? []).map((name) => ({
                                  name: present(name),
                                  origin: 'user' as const,
                                  columns: ['CODE'],
                                  unique: false,
                                  semantics,
                                  validity,
                                  nativeDefinition: absent,
                                })),
                              ],
                            },
                          ),
                        ),
                      },
                    ],
                  },
                },
              ]
            : [],
          coverage: complete,
        },
        nameReservations: { items: [], coverage: complete },
        constraintNameReservations: { items: [], coverage: complete },
        diagnostics: [],
      })

      const matching = planMigration(
        schemas,
        snapshot(true),
        runtime.dialect.migration.planning,
      )
      expect(matching.plan.steps).toEqual([])

      const fresh = planMigration(
        schemas,
        snapshot(false),
        runtime.dialect.migration.planning,
      )
      const referenceStep = fresh.plan.steps.find(
        (step) => step.kind === 'add_foreign_key',
      )
      expect(referenceStep).toMatchObject({
        target: {
          relation: {
            namespace: [{ role: 'database', identifier: { spelling: 'fixture_db' } }],
          },
          column: { spelling: 'parentId', comparisonKey: 'parentid' },
        },
        references: {
          relation: {
            namespace: [{ role: 'database', identifier: { spelling: 'fixture_db' } }],
            relation: { spelling: 'contract_parents' },
          },
          column: { spelling: 'id', comparisonKey: 'id' },
        },
      })
      expect(
        fresh.desiredTables
          .get(child)
          ?.columns.find((column) => column.identifier.comparisonKey === 'parentid')
          ?.reference,
      ).toMatchObject({ relation: parent, column: { comparisonKey: 'id' } })

      const planningMessage = (catalog: CatalogSnapshot) => {
        try {
          planMigration(schemas, catalog, runtime.dialect.migration.planning)
          throw new Error('Expected case-folded duplicate planning to fail')
        } catch (cause) {
          return cause instanceof Error ? cause.message : String(cause)
        }
      }

      expect([
        planningMessage(snapshot(true, { columns: ['DUPLICATE', 'duplicate'] })),
        planningMessage(snapshot(true, { columns: ['duplicate', 'DUPLICATE'] })),
      ]).toEqual([
        'Duplicate catalog column [database:"fixture_db", relation:"contract_parents", column:"duplicate"]',
        'Duplicate catalog column [database:"fixture_db", relation:"contract_parents", column:"duplicate"]',
      ])
      expect([
        planningMessage(snapshot(true, { indexes: ['DUPLICATE_IDX', 'duplicate_idx'] })),
        planningMessage(snapshot(true, { indexes: ['duplicate_idx', 'DUPLICATE_IDX'] })),
      ]).toEqual([
        'Duplicate catalog index [database:"fixture_db", relation:"contract_children", index:"duplicate_idx"]',
        'Duplicate catalog index [database:"fixture_db", relation:"contract_children", index:"duplicate_idx"]',
      ])

      const DuplicateColumns = defineTable(
        'duplicate_columns',
        {
          id: pipe(
            string(),
            column({ physicalType: { [runtime.dialect.id]: 'fixture_text' } }),
          ),
          ID: pipe(
            string(),
            column({ physicalType: { [runtime.dialect.id]: 'fixture_text' } }),
          ),
        },
        { primaryKey: 'id', namespace },
      )
      expect(() =>
        planMigration(
          [DuplicateColumns],
          snapshot(false),
          runtime.dialect.migration.planning,
        ),
      ).toThrow(/Duplicate desired columns.*column:"ID".*column:"id"/)

      const DuplicateIndexes = defineTable(
        'duplicate_indexes',
        {
          id: pipe(
            string(),
            column({ physicalType: { [runtime.dialect.id]: 'fixture_text' } }),
          ),
          code: pipe(
            string(),
            column({ physicalType: { [runtime.dialect.id]: 'fixture_text' } }),
          ),
        },
        {
          primaryKey: 'id',
          namespace,
          indexes: [
            { name: 'by_code', columns: ['code'] },
            { name: 'BY_CODE', columns: ['id'] },
          ],
        },
      )
      const duplicateIndexRequest = createCatalogRequest([DuplicateIndexes], [])
      expect(() =>
        planMigration(
          [DuplicateIndexes],
          {
            ...snapshot(false),
            request: {
              relations: duplicateIndexRequest.relations.map((entry) => ({
                identity: identities.resolve(entry.relation),
                shape: entry.shape,
              })),
              absentRelations: [],
              completeNamespaces: [],
            },
          },
          runtime.dialect.migration.planning,
        ),
      ).toThrow(/Duplicate desired indexes.*index:"BY_CODE".*index:"by_code"/)
    })

    it('routes case-folded query relation and member semantics through the selected member', async () => {
      const runtime = createRuntime()
      if (runtime.expected.memberComparison !== 'caseFolded') return
      const unregister = registerDialectForTest(runtime.dialect)
      const namespace = [{ role: 'database' as const, spelling: 'fixture_db' }]
      const CanonicalRecords = defineTable(
        'records',
        {
          id: pipe(
            string(),
            column({ physicalType: { [runtime.dialect.id]: 'fixture_text' } }),
          ),
          label: pipe(
            string(),
            column({ physicalType: { [runtime.dialect.id]: 'fixture_text' } }),
          ),
        },
        { primaryKey: 'id', namespace },
      )
      const AliasRecords = defineTable(
        'RECORDS',
        {
          ID: pipe(
            string(),
            column({ physicalType: { [runtime.dialect.id]: 'fixture_text' } }),
          ),
          LABEL: pipe(
            string(),
            column({ physicalType: { [runtime.dialect.id]: 'fixture_text' } }),
          ),
        },
        {
          primaryKey: 'ID',
          namespace: [{ role: 'database', spelling: 'FIXTURE_DB' }],
        },
      )
      const Links = defineTable(
        'links',
        {
          id: pipe(
            string(),
            column({ physicalType: { [runtime.dialect.id]: 'fixture_text' } }),
          ),
          recordId: reference(AliasRecords, 'ID'),
        },
        { primaryKey: 'id', namespace },
      )
      const relation = {
        namespace: [{ role: 'database' as const, spelling: 'FIXTURE_DB' }],
        relation: 'RECORDS',
      }

      try {
        const mapper = createValueMapper(runtime.dialect, undefined, [
          CanonicalRecords,
          Links,
        ])
        expect(mapper.columnTypes(Links).recordId).toBe('fixture_text')

        const db = createDatabase({
          connector: runtime.connector,
          schemas: [CanonicalRecords, Links],
        })

        try {
          const rows = await db
            .from(CanonicalRecords)
            .select(() => [
              {
                kind: 'column',
                relation,
                column: 'ID',
                alias: 'id',
              } as const,
              {
                kind: 'column',
                relation,
                column: 'LABEL',
                alias: 'label',
              } as const,
            ])
            .where({
              kind: 'cmp',
              relation,
              column: 'LABEL',
              op: 'eq',
              value: 'authored-value',
            })
            .execute()

          expect(rows).toEqual([
            {
              id: 'fixture-result:fixture_db.records.id:row-1',
              label:
                'fixture-result:fixture_db.records.label:fixture-param:authored-value',
            },
          ])
        } finally {
          await db.close()
        }

        const ambiguous = createDatabase({
          connector: runtime.connector,
          schemas: [CanonicalRecords, AliasRecords],
        })

        try {
          expect(() =>
            ambiguous
              .from(CanonicalRecords)
              .innerJoin(AliasRecords, eq(CanonicalRecords.id, AliasRecords.ID))
              .select(() => [
                {
                  kind: 'column',
                  relation,
                  column: 'ID',
                  alias: 'id',
                } as const,
              ])
              .compile(),
          ).toThrow(QueryError)
          expect(() =>
            ambiguous
              .from(CanonicalRecords)
              .innerJoin(AliasRecords, eq(CanonicalRecords.id, AliasRecords.ID))
              .select(() => [
                {
                  kind: 'column',
                  relation,
                  column: 'ID',
                  alias: 'id',
                } as const,
              ])
              .compile(),
          ).toThrow(/ambiguous in this query/i)
        } finally {
          await ambiguous.close()
        }
      } finally {
        unregister()
      }
    })

    it('reports applied and unchanged migration outcomes when advertised', async () => {
      const executeScenario = async (
        expected: 'applied' | 'unchanged',
      ): Promise<boolean> => {
        const runtime = createRuntime()

        if (runtime.migration.state === 'unsupported') {
          await runtime.connector.dispose?.()
          return false
        }

        const unregister = registerDialectForTest(runtime.dialect)
        const Records = defineTable(
          `migration_records_${expected}`,
          {
            id: pipe(string(), column({ physicalType: { [runtime.dialect.id]: 'id' } })),
          },
          { primaryKey: 'id' },
        )
        let closeDatabase: (() => Promise<void>) | undefined

        try {
          const db = createDatabase({
            connector: runtime.connector,
            schemas: expected === 'applied' ? [Records] : [],
          })
          closeDatabase = () => db.close()
          await db.migrate().execute()
          expect(runtime.migration.outcomes).toEqual([expected])
          return true
        } finally {
          try {
            await closeDatabase?.()
          } finally {
            unregister()
          }
        }
      }

      if (!(await executeScenario('applied'))) return
      expect(await executeScenario('unchanged')).toBe(true)
    })
  })
}
