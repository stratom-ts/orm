import { describe, expect, it } from 'vitest'

import { planMigration } from '@/ddl/migrationPlan'
import type { CatalogRelation, CatalogSnapshot, CatalogTable } from '@/dialects'
import type { CatalogExecutor } from '@/dialects/catalog'
import { sqliteCatalog, sqliteDialect } from '@/dialects/sqlite'

const observesARealSQLiteCatalogWithCanonicalIdentitiesAndRowidGenerationData = `
        PRAGMA foreign_keys = ON;
        CREATE TABLE parent (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          label TEXT NOT NULL DEFAULT 'parent',
          note TEXT
        );
        CREATE TABLE child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE
        );
        CREATE INDEX child_parent_idx ON child(parent_id);
      `

/** Checks whether a runtime parameter is accepted by node:sqlite. */
function isSqlInputValue(
  value: unknown,
): value is string | number | bigint | null | Uint8Array {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  )
}

const nodeSqliteSupported = (() => {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 13)
})()

/**
 * Finds the named relation in the observed SQLite catalog or fails the fixture check.
 *
 * @param snapshot - Observed catalog snapshot whose evidence is checked or projected.
 * @param name - Physical identifier or dialect label used by this operation.
 *
 * @returns The named relation in the observed SQLite catalog or fails the fixture check.
 */
function relationNamed(snapshot: CatalogSnapshot, name: string): CatalogRelation {
  const relation = snapshot.namespaces.items[0]?.relations.items.find(
    (entry) => entry.identity.relation.spelling === name,
  )

  expect(relation).toBeDefined()

  if (relation === undefined) throw new Error(`Missing SQLite relation ${name}`)

  return relation
}

/**
 * Requires present table evidence before an integration assertion reads its members.
 *
 * @param relation - Authored or canonical relation addressed by this operation.
 *
 * @returns Present table evidence; absent or unsupported table evidence fails the
 *   assertion.
 */
function tableOf(relation: CatalogRelation): CatalogTable {
  expect(relation.table.state).toBe('present')

  if (relation.table.state !== 'present')
    throw new Error(
      `Missing SQLite table evidence for ${relation.identity.relation.spelling}`,
    )

  return relation.table.value
}

describe('SQLite catalog introspection with node:sqlite', () => {
  it.runIf(nodeSqliteSupported)(
    'observes a real SQLite catalog with canonical identities and rowid generation',
    async () => {
      const { DatabaseSync } = await import('node:sqlite')
      const database = new DatabaseSync(':memory:')

      try {
        database.exec(
          observesARealSQLiteCatalogWithCanonicalIdentitiesAndRowidGenerationData,
        )

        const snapshot = await sqliteCatalog.introspectCatalog(
          {
            /** Executes fixture SQL with the configured native observations. */
            execute: async ({ sql, params }) =>
              database.prepare(sql).all(
                ...params.map((value) => {
                  if (!isSqlInputValue(value))
                    throw new TypeError('Invalid node:sqlite SQL input value')

                  return value
                }),
              ),
          },
          {
            relations: [],
            absentRelations: [],
            completeNamespaces: [[{ role: 'database', spelling: 'main' }]],
          },
        )

        const childTable = assertSqliteCatalogTables(snapshot)

        expect(childTable.indexes.items).toMatchObject([
          {
            name: { state: 'present', value: 'child_parent_idx' },
            columns: ['parent_id'],
          },
        ])
      } finally {
        database.close()
      }
    },
  )
})

describe('SQLite catalog introspection with inherited index collations', () => {
  it.runIf(nodeSqliteSupported)(
    'inherits a native column collation when classifying a bare user-index term',
    async () => {
      const { DatabaseSync } = await import('node:sqlite')
      const database = new DatabaseSync(':memory:')

      try {
        database.exec(`
          CREATE TABLE target (id INTEGER PRIMARY KEY, value TEXT COLLATE NOCASE);
          CREATE INDEX target_value ON target(value);
        `)

        const snapshot = await sqliteCatalog.introspectCatalog(
          createNodeSqliteExecutor(database),
          {
            relations: [],
            absentRelations: [],
            completeNamespaces: [[{ role: 'database', spelling: 'main' }]],
          },
        )

        const relation = relationNamed(snapshot, 'target')
        const table = tableOf(relation)

        expect(table.indexes.coverage.state).toBe('complete')

        expect(table.indexes.items).toMatchObject([
          {
            name: { state: 'present', value: 'target_value' },
            columns: ['value'],
            semantics: { state: 'unsupported' },
          },
        ])

        expect(snapshot.diagnostics).not.toContainEqual(
          expect.objectContaining({ code: 'catalog.sqlite.metadata' }),
        )
      } finally {
        database.close()
      }
    },
  )
})

describe('SQLite catalog introspection with literal index terms', () => {
  it.runIf(nodeSqliteSupported)(
    'preserves literal constant index terms as unsupported rich semantics',
    async () => {
      const { DatabaseSync } = await import('node:sqlite')
      const database = new DatabaseSync(':memory:')

      try {
        database.exec(`
          CREATE TABLE target (id INTEGER PRIMARY KEY, value TEXT);
          CREATE INDEX target_number ON target(1);
        `)

        const snapshot = await sqliteCatalog.introspectCatalog(
          createNodeSqliteExecutor(database),
          {
            relations: [],
            absentRelations: [],
            completeNamespaces: [[{ role: 'database', spelling: 'main' }]],
          },
        )

        const table = tableOf(relationNamed(snapshot, 'target'))

        expect(table.indexes.coverage.state).toBe('complete')

        expect(table.indexes.items).toMatchObject([
          {
            name: { state: 'present', value: 'target_number' },
            columns: [],
            semantics: { state: 'unsupported' },
            nativeDefinition: { state: 'present' },
          },
        ])

        expect(snapshot.diagnostics).not.toContainEqual(
          expect.objectContaining({ code: 'catalog.sqlite.metadata' }),
        )
      } finally {
        database.close()
      }
    },
  )
})

describe('SQLite catalog introspection with quote-bent index terms', () => {
  it.runIf(nodeSqliteSupported)(
    'matches a single-quoted column term to its native table column',
    async () => {
      const { DatabaseSync } = await import('node:sqlite')
      const database = new DatabaseSync(':memory:')

      try {
        database.exec(`
          CREATE TABLE target (id INTEGER PRIMARY KEY, value TEXT);
          CREATE INDEX target_value ON target('value');
        `)

        const snapshot = await sqliteCatalog.introspectCatalog(
          createNodeSqliteExecutor(database),
          {
            relations: [],
            absentRelations: [],
            completeNamespaces: [[{ role: 'database', spelling: 'main' }]],
          },
        )

        const table = tableOf(relationNamed(snapshot, 'target'))

        expect(table.indexes.coverage.state).toBe('complete')

        expect(table.indexes.items).toMatchObject([
          {
            name: { state: 'present', value: 'target_value' },
            columns: ['value'],
            semantics: { state: 'present', value: { kind: 'simple' } },
            nativeDefinition: { state: 'present' },
          },
        ])

        expect(snapshot.diagnostics).not.toContainEqual(
          expect.objectContaining({ code: 'catalog.sqlite.metadata' }),
        )
      } finally {
        database.close()
      }
    },
  )
})

describe('SQLite catalog introspection with quoted declared types', () => {
  it.runIf(nodeSqliteSupported)(
    'compares punctuation-bearing type names independently of identifier quoting',
    async () => {
      const { DatabaseSync } = await import('node:sqlite')
      const database = new DatabaseSync(':memory:')

      try {
        database.exec(`
          CREATE TABLE target (
            value "VARCHAR(12)",
            comment_like "A--B",
            escaped "A""B""C",
            spaced "A B",
            explicit_null TEXT NULL,
            default_null TEXT DEFAULT 'x' NULL
          )
        `)

        const snapshot = await sqliteCatalog.introspectCatalog(
          createNodeSqliteExecutor(database),
          {
            relations: [],
            absentRelations: [],
            completeNamespaces: [[{ role: 'database', spelling: 'main' }]],
          },
        )

        const table = tableOf(relationNamed(snapshot, 'target'))

        expect(table.columns.coverage.state).toBe('complete')

        expect(table.columns.items.map(({ dataType }) => dataType)).toMatchObject([
          { state: 'present', value: { native: 'VARCHAR(12)' } },
          { state: 'present', value: { native: 'A--B' } },
          { state: 'present', value: { native: 'A"B"C' } },
          { state: 'present', value: { native: 'A B' } },
          { state: 'present', value: { native: 'TEXT' } },
          { state: 'present', value: { native: 'TEXT' } },
        ])

        expect(snapshot.diagnostics).not.toContainEqual(
          expect.objectContaining({ code: 'catalog.sqlite.metadata' }),
        )
      } finally {
        database.close()
      }
    },
  )
})

const declaredTypeContradictionCases = [
  ['escaped identifier quotes', 'CREATE TABLE target(value "A""B""C")', 'ABC'],
  ['significant quoted whitespace', 'CREATE TABLE target(value "A B")', 'A  B'],
  ['explicit NULL', 'CREATE TABLE target(value TEXT NULL)', 'TEXT NULL'],
] as const

/** Mutates one decoded table_xinfo type while optionally reversing every result. */
function mutatedDeclaredTypeExecutor(
  native: CatalogExecutor,
  observedType: string,
  reverse: boolean,
): CatalogExecutor {
  return {
    execute: async (query) => {
      let rows = await native.execute(query)

      if (query.sql.includes('pragma_table_xinfo') && query.params[0] === 'target')
        rows = rows.map((row) =>
          (row as { name?: string }).name === 'value'
            ? { ...(row as Record<string, unknown>), type: observedType }
            : row,
        )

      return reverse ? [...rows].reverse() : rows
    },
  }
}

describe('SQLite catalog introspection with contradictory quoted declared types', () => {
  it.runIf(nodeSqliteSupported).each(declaredTypeContradictionCases)(
    'rejects a stable %s mutation',
    async (_label, sql, observedType) => {
      const { DatabaseSync } = await import('node:sqlite')
      const database = new DatabaseSync(':memory:')

      try {
        database.exec(sql)
        const native = createNodeSqliteExecutor(database)
        const observe = (reverse: boolean) =>
          sqliteCatalog.introspectCatalog(
            mutatedDeclaredTypeExecutor(native, observedType, reverse),
            mainRequest,
          )

        const snapshot = await observe(false)
        expect(await observe(true)).toEqual(snapshot)

        const relation = relationNamed(snapshot, 'target')
        const table = tableOf(relation)
        expect(relation.management).toBe('unmanaged')
        expect(table.columns.coverage.state).toBe('unknown')
        expect(table.options.coverage.state).toBe('complete')

        expect(snapshot.diagnostics).toContainEqual(
          expect.objectContaining({
            code: 'catalog.sqlite.metadata',
            target: relation.identity,
          }),
        )
      } finally {
        database.close()
      }
    },
  )
})

describe('SQLite catalog introspection with node:sqlite: observes attached and temporary relations and maps UNIQUE auto-indexes conservatively', () => {
  it.runIf(nodeSqliteSupported)(
    'observes attached and temporary relations and maps UNIQUE auto-indexes conservatively',
    async () => {
      const { DatabaseSync } = await import('node:sqlite')
      const database = new DatabaseSync(':memory:')

      try {
        database.exec(`
          ATTACH DATABASE ':memory:' AS aux;
          CREATE TABLE aux.external_data (id INTEGER PRIMARY KEY);
          CREATE TEMP TABLE transient_data (id INTEGER PRIMARY KEY);
          CREATE TABLE unique_data (left_value TEXT, right_value TEXT, UNIQUE (left_value, right_value));
        `)

        const snapshot = await sqliteCatalog.introspectCatalog(
          createNodeSqliteExecutor(database),
          {
            relations: [],
            absentRelations: [],
            completeNamespaces: [[{ role: 'database', spelling: 'main' }]],
          },
        )

        const unique = tableOf(relationNamed(snapshot, 'unique_data'))

        expect(unique.uniqueConstraints.items).toMatchObject([
          {
            columns: ['left_value', 'right_value'],
            semantics: { state: 'present', value: { kind: 'simple' } },
            validity: { state: 'present', value: 'valid' },
          },
        ])

        expect(unique.indexes.items).toEqual([])
        expect(relationNamed(snapshot, 'unique_data').management).toBe('unmanaged')

        expect(snapshot.diagnostics.map(({ code }) => code)).toEqual([
          'catalog.sqlite.attached',
          'catalog.sqlite.temporary',
          'catalog.sqlite.unmanaged-relation',
          'catalog.sqlite.unmanaged-relation',
        ])
      } finally {
        database.close()
      }
    },
  )
})

const mainRequest = {
  relations: [],
  absentRelations: [],
  completeNamespaces: [[{ role: 'database' as const, spelling: 'main' }]],
}

/** Removes the same native observation on every read, optionally reversing all row orders. */
function omittedConstraintExecutor(
  native: CatalogExecutor,
  name: string,
  omittedQuery: string,
  reverse: boolean,
): CatalogExecutor {
  return {
    execute: async (query) => {
      if (query.sql.includes(omittedQuery) && query.params[0] === name) return []

      let rows = await native.execute(query)

      if (omittedQuery === 'index_list' && query.sql.includes('sqlite_schema'))
        rows = rows.filter(
          (row) =>
            (row as { type?: string; tbl_name?: string }).type !== 'index' ||
            (row as { tbl_name?: string }).tbl_name !== name,
        )

      return reverse ? [...rows].reverse() : rows
    },
  }
}

/** Adds a consistent but invented UNIQUE autoindex to both SQLite inventories. */
function extraUniqueExecutor(native: CatalogExecutor): CatalogExecutor {
  const name = 'sqlite_autoindex_target_1'
  return {
    execute: async (query) => {
      const rows = await native.execute(query)

      if (query.sql.includes('index_list') && query.params[0] === 'target')
        return [{ seq: 0, name, unique: 1, origin: 'u', partial: 0 }]

      if (query.sql.includes('index_xinfo') && query.params[0] === name)
        return [{ seqno: 0, cid: 1, name: 'value', desc: 0, coll: 'BINARY', key: 1 }]

      if (query.sql.includes('sqlite_schema'))
        return [...rows, { type: 'index', name, tbl_name: 'target', sql: null }]

      return rows
    },
  }
}

it.runIf(nodeSqliteSupported).each([
  [
    'foreign key',
    'CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))',
    'child',
    'foreign_key_list',
    'foreignKeys',
    'missing foreign-key evidence',
  ],
  [
    'TEXT primary key',
    'CREATE TABLE target(id TEXT PRIMARY KEY)',
    'target',
    'index_list',
    'primaryKey',
    'missing primary-key index evidence',
  ],
  [
    'composite primary key',
    'CREATE TABLE target(a TEXT, b TEXT, PRIMARY KEY(a,b))',
    'target',
    'index_list',
    'primaryKey',
    'missing primary-key index evidence',
  ],
  [
    'INTEGER PRIMARY KEY DESC',
    'CREATE TABLE target(id INTEGER PRIMARY KEY DESC)',
    'target',
    'index_list',
    'primaryKey',
    'missing primary-key index evidence',
  ],
  [
    'UNIQUE',
    'CREATE TABLE target(id INTEGER PRIMARY KEY, value TEXT UNIQUE)',
    'target',
    'index_list',
    'uniqueConstraints',
    'missing UNIQUE index evidence',
  ],
  [
    'rowid UNIQUE',
    'CREATE TABLE target(id INTEGER PRIMARY KEY UNIQUE)',
    'target',
    'index_list',
    'uniqueConstraints',
    'missing UNIQUE index evidence',
  ],
] as const)(
  'rejects consistently omitted %s metadata',
  async (_label, sql, name, omittedQuery, affected, message) => {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(':memory:')
    try {
      database.exec(sql)
      const native = createNodeSqliteExecutor(database)
      const observe = (reverse: boolean) =>
        sqliteCatalog.introspectCatalog(
          omittedConstraintExecutor(native, name, omittedQuery, reverse),
          mainRequest,
        )

      const snapshot = await observe(false)
      expect(await observe(true)).toEqual(snapshot)
      const relation = relationNamed(snapshot, name)
      const table = tableOf(relation)
      expect(relation.management).toBe('unmanaged')
      expect(relation.nativeDefinition.state).toBe('present')
      expect(table.columns.coverage.state).toBe('complete')

      expect(
        affected === 'primaryKey'
          ? table.primaryKey.state
          : table[affected].coverage.state,
      ).toBe('unknown')

      expect(snapshot.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'catalog.sqlite.metadata',
          message: expect.stringContaining(message) as unknown,
        }),
      )

      expect(() =>
        planMigration([], snapshot, sqliteDialect.migration.planning, {
          migrationOwnership: [
            { kind: 'completeNamespace', namespace: mainRequest.completeNamespaces[0]! },
          ],
        }),
      ).toThrow(/catalog|unknown|incomplete/i)
    } finally {
      database.close()
    }
  },
)

it.runIf(nodeSqliteSupported)(
  'does not infer rowid generation or nullability when the DESC primary-key index is omitted',
  async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(':memory:')
    try {
      database.exec('CREATE TABLE target(id INTEGER PRIMARY KEY DESC)')
      const snapshot = await sqliteCatalog.introspectCatalog(
        omittedConstraintExecutor(
          createNodeSqliteExecutor(database),
          'target',
          'index_list',
          false,
        ),
        mainRequest,
      )

      const id = tableOf(relationNamed(snapshot, 'target')).columns.items[0]!
      expect(id.generation.state).toBe('unknown')
      expect(id.nullable.state).toBe('unknown')
    } finally {
      database.close()
    }
  },
)

it.runIf(nodeSqliteSupported)(
  'distinguishes real clauses from quoted names, defaults, and comments',
  async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(':memory:')
    try {
      database.exec(`CREATE TABLE "(" ("x,y" TEXT DEFAULT 'REFERENCES PRIMARY KEY UNIQUE (', 'UNIQUE' TEXT,
      café TEXT, a$b TEXT, id INTEGER PRIMARY KEY) /* REFERENCES UNIQUE PRIMARY KEY */`)

      const snapshot = await sqliteCatalog.introspectCatalog(
        createNodeSqliteExecutor(database),
        mainRequest,
      )

      const relation = relationNamed(snapshot, '(')
      expect(relation.management).toBe('managed')
      expect(tableOf(relation).foreignKeys.items).toEqual([])
      expect(tableOf(relation).uniqueConstraints.items).toEqual([])

      expect(tableOf(relation).columns.items.at(-1)!.generation).toMatchObject({
        state: 'present',
        value: { kind: 'rowidAlias' },
      })
    } finally {
      database.close()
    }
  },
)

it.runIf(nodeSqliteSupported)(
  'keeps distinct actions for multiple inline foreign keys',
  async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(':memory:')
    try {
      database.exec(`CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE q(id INTEGER PRIMARY KEY);
      CREATE TABLE child(id INTEGER PRIMARY KEY, value INTEGER REFERENCES p(id) ON DELETE CASCADE REFERENCES q(id) ON DELETE RESTRICT)`)

      const snapshot = await sqliteCatalog.introspectCatalog(
        createNodeSqliteExecutor(database),
        mainRequest,
      )

      const relation = relationNamed(snapshot, 'child')
      expect(relation.management).toBe('managed')

      expect(
        tableOf(relation).foreignKeys.items.map((key) => [
          key.referencedRelation.relation.spelling,
          key.onDelete,
        ]),
      ).toEqual([
        ['p', 'cascade'],
        ['q', 'restrict'],
      ])
    } finally {
      database.close()
    }
  },
)

it.runIf(nodeSqliteSupported)(
  'accepts SQLite deduplication of opposite UNIQUE sort directions',
  async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(':memory:')
    try {
      database.exec(
        'CREATE TABLE target(id INTEGER PRIMARY KEY, value TEXT, UNIQUE(value), UNIQUE(value DESC))',
      )

      const snapshot = await sqliteCatalog.introspectCatalog(
        createNodeSqliteExecutor(database),
        mainRequest,
      )

      const relation = relationNamed(snapshot, 'target')
      expect(relation.management).toBe('managed')
      expect(tableOf(relation).uniqueConstraints.coverage.state).toBe('complete')
      expect(tableOf(relation).uniqueConstraints.items).toHaveLength(1)
    } finally {
      database.close()
    }
  },
)

it.runIf(nodeSqliteSupported)(
  'accepts a primary key sharing an earlier UNIQUE index direction',
  async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(':memory:')
    try {
      database.exec('CREATE TABLE target(value TEXT UNIQUE, PRIMARY KEY(value DESC))')
      const snapshot = await sqliteCatalog.introspectCatalog(
        createNodeSqliteExecutor(database),
        mainRequest,
      )

      const relation = relationNamed(snapshot, 'target')
      expect(relation.management).toBe('managed')
      expect(tableOf(relation).primaryKey.state).toBe('present')
      expect(tableOf(relation).uniqueConstraints.coverage.state).toBe('complete')
    } finally {
      database.close()
    }
  },
)

it.runIf(nodeSqliteSupported)(
  'rejects an extra UNIQUE autoindex absent from native table SQL',
  async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(':memory:')
    try {
      database.exec('CREATE TABLE target(id INTEGER PRIMARY KEY, value TEXT)')
      const snapshot = await sqliteCatalog.introspectCatalog(
        extraUniqueExecutor(createNodeSqliteExecutor(database)),
        mainRequest,
      )

      const relation = relationNamed(snapshot, 'target')
      expect(relation.management).toBe('unmanaged')
      expect(tableOf(relation).uniqueConstraints.coverage.state).toBe('unknown')

      expect(snapshot.diagnostics).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining(
            'inconsistent native constraint index evidence',
          ) as unknown,
        }),
      )
    } finally {
      database.close()
    }
  },
)

it.runIf(nodeSqliteSupported)(
  'rejects an explicit target forged for an implicit parent-key reference',
  async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(':memory:')
    try {
      database.exec(
        'CREATE TABLE parent(id INTEGER PRIMARY KEY, value TEXT UNIQUE); CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent)',
      )

      const native = createNodeSqliteExecutor(database)
      const snapshot = await sqliteCatalog.introspectCatalog(
        {
          execute: async (query) => {
            const rows = await native.execute(query)
            return query.sql.includes('foreign_key_list') && query.params[0] === 'child'
              ? rows.map((row) => ({ ...(row as Record<string, unknown>), to: 'value' }))
              : rows
          },
        },
        mainRequest,
      )

      expect(tableOf(relationNamed(snapshot, 'child')).foreignKeys.coverage.state).toBe(
        'unknown',
      )

      expect(snapshot.diagnostics).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('missing foreign-key evidence') as unknown,
        }),
      )
    } finally {
      database.close()
    }
  },
)

it.runIf(nodeSqliteSupported)(
  'rejects a missing collated UNIQUE index despite a same-column BINARY index',
  async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(':memory:')
    try {
      database.exec(
        'CREATE TABLE target(id INTEGER PRIMARY KEY, value TEXT, UNIQUE(value), UNIQUE(value COLLATE NOCASE))',
      )

      const indexes = database.prepare('pragma index_list(target)').all() as {
        name: string
        seq: number
      }[]

      const omitted = indexes.find((index) =>
        (
          database.prepare(`pragma index_xinfo("${index.name}")`).all() as {
            coll: string
          }[]
        ).some((term) => term.coll === 'NOCASE'),
      )!.name

      const native = createNodeSqliteExecutor(database)
      const snapshot = await sqliteCatalog.introspectCatalog(
        {
          execute: async (query) => {
            const rows = await native.execute(query)

            if (query.sql.includes('index_list') && query.params[0] === 'target')
              return rows
                .filter((row) => (row as { name: string }).name !== omitted)
                .map((row, seq) => ({ ...(row as Record<string, unknown>), seq }))

            if (query.sql.includes('sqlite_schema'))
              return rows.filter((row) => (row as { name?: string }).name !== omitted)

            return rows
          },
        },
        mainRequest,
      )

      expect(
        tableOf(relationNamed(snapshot, 'target')).uniqueConstraints.coverage.state,
      ).toBe('unknown')

      expect(snapshot.diagnostics).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('missing UNIQUE index evidence') as unknown,
        }),
      )
    } finally {
      database.close()
    }
  },
)

it.runIf(nodeSqliteSupported)(
  'rejects primary-key index direction that contradicts INTEGER PRIMARY KEY DESC',
  async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(':memory:')
    try {
      database.exec('CREATE TABLE target(id INTEGER PRIMARY KEY DESC)')
      const native = createNodeSqliteExecutor(database)
      const snapshot = await sqliteCatalog.introspectCatalog(
        {
          execute: async (query) => {
            const rows = await native.execute(query)
            return query.sql.includes('index_xinfo')
              ? rows.map((row) => ({ ...(row as Record<string, unknown>), desc: 0 }))
              : rows
          },
        },
        mainRequest,
      )

      const relation = relationNamed(snapshot, 'target')
      expect(relation.management).toBe('unmanaged')
      expect(tableOf(relation).primaryKey.state).toBe('unknown')
      expect(tableOf(relation).columns.items[0]!.generation.state).toBe('absent')

      expect(snapshot.diagnostics).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining(
            'inconsistent primary-key index evidence',
          ) as unknown,
        }),
      )
    } finally {
      database.close()
    }
  },
)

it.runIf(nodeSqliteSupported).each(['target', 'action'] as const)(
  'rejects foreign-key %s observations that contradict native SQL',
  async (changed) => {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(':memory:')
    try {
      database.exec(
        'CREATE TABLE parent(id INTEGER PRIMARY KEY, value TEXT UNIQUE); CREATE TABLE child(id INTEGER PRIMARY KEY, parent_value TEXT REFERENCES parent(value) ON DELETE CASCADE)',
      )

      const native = createNodeSqliteExecutor(database)
      const snapshot = await sqliteCatalog.introspectCatalog(
        {
          execute: async (query) => {
            const rows = await native.execute(query)

            if (query.sql.includes('foreign_key_list') && query.params[0] === 'child')
              return rows.map((row) => ({
                ...(row as Record<string, unknown>),
                ...(changed === 'target' ? { to: 'id' } : { on_delete: 'RESTRICT' }),
              }))

            return rows
          },
        },
        mainRequest,
      )

      expect(tableOf(relationNamed(snapshot, 'child')).foreignKeys.coverage.state).toBe(
        'unknown',
      )

      expect(snapshot.diagnostics).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('missing foreign-key evidence') as unknown,
        }),
      )
    } finally {
      database.close()
    }
  },
)

/**
 * Checks real SQLite catalog identity, table management, and decoded member evidence.
 *
 * @param snapshot - Observed catalog snapshot whose evidence is checked or projected.
 *
 * @returns Verified child-table evidence for subsequent foreign-key assertions.
 */
function assertSqliteCatalogTables(snapshot: CatalogSnapshot) {
  expect(snapshot.source).toMatchObject({ dialect: 'sqlite' })
  expect(snapshot.namespaces.coverage).toEqual({ state: 'complete' })
  const relations = snapshot.namespaces.items[0]?.relations.items ?? []
  expect(relations.map(({ identity }) => identity.relation.spelling)).toEqual([
    'child',
    'parent',
  ])

  const parent = relationNamed(snapshot, 'parent')
  const child = relationNamed(snapshot, 'child')
  const parentTable = tableOf(parent)
  const childTable = tableOf(child)

  expect(parent.management).toBe('managed')

  assertSqliteParentColumns(parentTable)

  expect(childTable.foreignKeys.items[0]).toMatchObject({
    columns: ['parent_id'],
    referencedRelation: {
      namespace: [
        {
          role: 'database',
          identifier: { spelling: 'main', comparisonKey: 'main' },
        },
      ],
      relation: { spelling: 'parent', comparisonKey: 'parent' },
    },
    referencedColumns: ['id'],
    validity: { state: 'present', value: 'valid' },
    onDelete: 'cascade',
  })

  return childTable
}

/**
 * Checks the parent table's native storage, defaults, and rowid generation evidence.
 *
 * @param parentTable - Parent relation used to check referenced-key evidence.
 */
function assertSqliteParentColumns(parentTable: CatalogTable) {
  expect(parentTable.columns.items[0]!.dataType).toMatchObject({
    state: 'present',
    value: { native: 'INTEGER', comparisonKey: 'integer' },
  })

  expect(parentTable.columns.items[0]!.generation).toEqual({
    state: 'present',
    value: { kind: 'rowidAlias', autoIncrement: true },
  })

  expect(parentTable.columns.items[1]!.default).toMatchObject({
    state: 'present',
    value: {
      kind: 'literal',
      native: "'parent'",
      comparisonKey: { state: 'present', value: "'parent'" },
    },
  })

  expect(parentTable.columns.items[1]!.nullable).toEqual({
    state: 'present',
    value: false,
  })

  expect(parentTable.columns.items[2]!.nullable).toEqual({
    state: 'present',
    value: true,
  })
}

/**
 * Executes catalog SQL through node:sqlite after checking supported parameter values.
 *
 * @param database - Native database identity or spelling used to scope fixture resources.
 *
 * @returns A catalog executor that validates bindings before node:sqlite execution.
 */
function createNodeSqliteExecutor(
  database: import('node:sqlite').DatabaseSync,
): CatalogExecutor {
  return {
    /** Executes fixture SQL with the configured native observations. */
    execute: async ({ sql, params }) =>
      database.prepare(sql).all(
        ...params.map((value) => {
          if (!isSqlInputValue(value))
            throw new TypeError('Invalid node:sqlite SQL input value')

          return value
        }),
      ),
  }
}
