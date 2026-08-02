import { describe, expect, it } from 'vitest'

import type { CatalogExecutor, CatalogRequest } from '@/dialects'
import { postgresDialect } from '@/index'

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

function executor(
  options: {
    reverse?: boolean
    version?: string
    raced?: boolean
    deleted?: boolean
    changedMembers?: boolean
    malformedIndex?: boolean
    unrelatedRace?: boolean
    relationKind?: 'r' | 'v'
  } = {},
): CatalogExecutor {
  const order = <T>(rows: T[]) => (options.reverse ? rows.reverse() : rows)
  let relationQueries = 0
  let columnQueries = 0
  return {
    async execute({ sql }) {
      if (sql.includes('current_database()')) {
        return [
          {
            database: 'test',
            schema: 'public',
            version: options.version ?? '160000',
          },
        ]
      }
      if (sql.includes('-- catalog:namespace')) {
        return [{ schema: 'public', owner: 'app' }]
      }
      if (sql.includes('as relation_kind')) {
        relationQueries++
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
        if (options.unrelatedRace) {
          rows.push({
            ...rows[0]!,
            object_id: String(1000 + relationQueries),
            name: 'audit_log',
          })
        }
        return rows
      }
      if (sql.includes('-- catalog:column')) {
        columnQueries++
        const rows = [
          {
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
          },
          {
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
          },
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
            is_nullable: 'YES',
            column_default: null,
            is_identity: 'NO',
            identity_generation: null,
            is_generated: 'NEVER',
            generation_expression: null,
          },
          {
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
          },
        ]
        if (options.changedMembers && columnQueries > 1) rows.pop()
        return order(rows)
      }
      if (sql.includes('from pg_index i')) {
        return order([
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
            native_definition:
              'create index events_quoted_idx on events ("payload,part")',
          },
          {
            schema: 'public',
            table_name: 'events',
            index_name: 'events_lower_payload_idx',
            is_unique: false,
            is_valid: true,
            nulls_not_distinct: false,
            has_supported_semantics: false,
            columns: options.malformedIndex ? '[invalid json]' : [],
            native_definition:
              'create index events_lower_payload_idx on events (lower(payload))',
          },
        ])
      }
      if (sql.includes('from pg_constraint con')) {
        return [
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
      }
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
      if (sql.includes('as object_name')) {
        return order([
          { schema: 'public', object_name: 'events' },
          { schema: 'public', object_name: 'events_payload_idx' },
        ])
      }
      return []
    },
  }
}

describe('PostgreSQL evidence-bearing catalog', () => {
  it('normalizes row-order permutations and preserves native objects', async () => {
    const queries: Parameters<CatalogExecutor['execute']>[0][] = []
    const delegate = executor()
    const first = await postgresDialect.catalog.introspectCatalog(
      {
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
    expect(richIndex.semantics.state).toBe('unsupported')
    expect(richIndex.nativeDefinition).toEqual({
      state: 'present',
      value: 'create index events_lower_payload_idx on events (lower(payload))',
    })
    expect(relation.table.value.options.items).toContainEqual({
      name: 'fillfactor',
      value: '90',
    })
    expect(
      relation.table.value.columns.items.find(
        (column) => column.name === 'normalized_payload',
      )?.generation,
    ).toEqual({
      state: 'present',
      value: {
        kind: 'computed',
        storage: 'stored',
        expression: 'lower(payload)',
      },
    })
    expect(
      relation.table.value.columns.items.find((column) => column.name === 'status')
        ?.dataType,
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
      relation.table.value.indexes.items.find(
        (index) => index.name.state === 'present' && index.name.value.includes('quoted'),
      )?.columns,
    ).toEqual([' payload,part ', 'NULL'])
    expect(relation.table.value.opaqueObjects.items[0]).toMatchObject({
      kind: 'trigger',
      reason: expect.stringMatching(/not managed/i),
    })
    expect(first.namespaces.items[0]!.relations.coverage).toMatchObject({
      state: 'partial',
      remainder: { state: 'unmanaged' },
    })
    for (const query of queries.slice(1)) {
      expect(query.sql).toContain('n.nspname = any($1::text[])')
      expect(query.params).toEqual([['public']])
    }

    const completeNamespace = await postgresDialect.catalog.introspectCatalog(
      executor(),
      {
        relations: [],
        absentRelations: [],
        completeNamespaces: [[{ role: 'schema', spelling: 'public' }]],
      },
    )
    expect(completeNamespace.namespaces.items[0]!.relations.coverage).toEqual({
      state: 'complete',
    })
  })

  it('ignores unrelated races and skips table-shaped rows for views', async () => {
    await expect(
      postgresDialect.catalog.introspectCatalog(
        executor({ unrelatedRace: true }),
        request,
      ),
    ).resolves.toBeDefined()

    const view = await postgresDialect.catalog.introspectCatalog(
      executor({ relationKind: 'v' }),
      request,
    )
    expect(view.namespaces.items[0]!.relations.items[0]!.table).toEqual({
      state: 'absent',
    })
  })

  it('reports unsupported server versions', async () => {
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

  it('rejects malformed and cross-query raced rows instead of fabricating facts', async () => {
    await expect(
      postgresDialect.catalog.introspectCatalog(
        executor({ malformedIndex: true }),
        request,
      ),
    ).rejects.toThrow(/malformed postgresql index row.*columns/i)

    await expect(
      postgresDialect.catalog.introspectCatalog(executor({ raced: true }), request),
    ).rejects.toThrow(/catalog changed during introspection.*missing table/i)

    await expect(
      postgresDialect.catalog.introspectCatalog(executor({ deleted: true }), request),
    ).rejects.toThrow(/catalog changed during introspection.*removed/i)

    await expect(
      postgresDialect.catalog.introspectCatalog(
        executor({ changedMembers: true }),
        request,
      ),
    ).rejects.toThrow(/catalog changed during introspection.*column observations differ/i)
  })
})
