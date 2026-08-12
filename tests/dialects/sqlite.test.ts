import {
  bigint,
  blob,
  boolean,
  date,
  integer,
  nullable,
  number,
  object,
  pipe,
  string,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { lowerDesiredSchema, registerDesiredSchema } from '@/ddl/desiredSchema'
import { normalizeSqliteDefaultExpression } from '@/dialects/sqlite'
import { column, defineTable, reference, resolveDialect, sqliteCore } from '@/index'
import type { DialectCore } from '@/index'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import {
  SQLITE_PHYSICAL_NAMING,
  createPhysicalNameRegistry,
  generatedIndexName,
  physicalNamingProfile,
} from '@/migrations/physicalNaming'
import { createValueMapper } from '@/query'

const identity = createCanonicalRelationIdentityModule({
  adapter: 'sqlite',
  context: { writableDefault: [{ role: 'database', spelling: 'main' }] },
})

describe('SQLite core facet', () => {
  it('exposes the public core type and export without registering SQLite', () => {
    const core: DialectCore = sqliteCore
    expect(core).toBe(sqliteCore)
    expect(() => resolveDialect('sqlite')).toThrow(/unsupported connector dialect/)
  })

  it('compiles CRUD, nested predicates, joins, aliases and positional parameters', () => {
    expect(
      sqliteCore.compile({
        kind: 'select',
        table: 'users',
        selection: [{ kind: 'column', column: 'name', alias: 'label' }],
        joins: [
          {
            type: 'left',
            table: 'teams',
            on: {
              kind: 'cmp',
              column: 'team_id',
              table: 'users',
              op: 'eq',
              right: { column: 'id', table: 'teams' },
            },
          },
        ],
        where: {
          kind: 'and',
          preds: [
            { kind: 'cmp', column: 'active', op: 'eq', value: true },
            { kind: 'not', pred: { kind: 'cmp', column: 'name', op: 'eq', value: null } },
          ],
        },
        orderBy: [{ column: 'name', direction: 'asc' }],
        limit: 5,
        offset: 2,
      }),
    ).toEqual({
      sql: 'select "name" as "label" from "main"."users" as "main.users" left join "main"."teams" as "main.teams" on "main.users"."team_id" = "main.teams"."id" where ("active" = ? and (not "name" is null)) order by "name" asc limit ? offset ?',
      params: [true, 5, 2],
    })
    expect(
      sqliteCore.compile({
        kind: 'insert',
        table: 'users',
        columns: ['name'],
        values: [['Ada']],
        returning: { kind: 'columns', columns: ['id'] },
      }),
    ).toEqual({
      sql: 'insert into "main"."users" ("name") values (?) returning "id"',
      params: ['Ada'],
    })
    expect(
      sqliteCore.compile({
        kind: 'update',
        table: 'users',
        set: [{ column: 'name', value: 'Grace' }],
        where: { kind: 'cmp', column: 'id', op: 'eq', value: 1 },
        allowAll: false,
      }),
    ).toEqual({
      sql: 'update "main"."users" as "main.users" set "name" = ? where "id" = ?',
      params: ['Grace', 1],
    })
    expect(
      sqliteCore.compile({
        kind: 'delete',
        table: 'users',
        where: { kind: 'cmp', column: 'id', op: 'eq', value: 1 },
        allowAll: false,
      }),
    ).toEqual({ sql: 'delete from "main"."users" where "id" = ?', params: [1] })
  })

  it('covers SQLite-supported expressions, predicates, offset-only paging, and escaping', () => {
    const compiled = sqliteCore.compile({
      kind: 'select',
      table: 'a"b',
      selection: [
        { kind: 'expr', expr: { kind: 'count_all' }, alias: 'count' },
        {
          kind: 'expr',
          expr: { kind: 'lower', arg: { kind: 'column', column: 'Name' } },
          alias: 'lower',
        },
        {
          kind: 'expr',
          expr: { kind: 'upper', arg: { kind: 'column', column: 'Name' } },
          alias: 'upper',
        },
        {
          kind: 'expr',
          expr: { kind: 'length', arg: { kind: 'column', column: 'Name' } },
          alias: 'length',
        },
        { kind: 'expr', expr: { kind: 'now' }, alias: 'now' },
      ],
      joins: [
        {
          type: 'inner',
          table: 'b',
          on: {
            kind: 'cmp',
            column: 'id',
            table: 'a"b',
            op: 'eq',
            right: { column: 'a_id', table: 'b' },
          },
        },
      ],
      where: { kind: 'or', preds: [] },
      groupBy: [{ column: 'Name' }],
      having: { kind: 'cmp', column: 'Name', op: 'neq', value: null },
      offset: 3,
    })
    expect(compiled.sql).toContain('inner join')
    expect(compiled.sql).toContain('count(*)')
    expect(compiled.sql).toContain('current_timestamp')
    expect(compiled.sql).toContain('limit ? offset ?')
    expect(compiled.params).toEqual([-1, 3])
    expect(
      sqliteCore.compile({
        kind: 'update',
        table: 'users',
        set: [{ column: 'x', value: 1 }],
        allowAll: true,
        returning: { kind: 'all' },
      }).sql,
    ).toContain('returning *')
    expect(
      sqliteCore.compile({
        kind: 'delete',
        table: 'users',
        allowAll: true,
        returning: { kind: 'columns', columns: ['id'] },
      }).sql,
    ).toContain('returning "id"')
    expect(
      sqliteCore.compile({
        kind: 'select',
        table: 'users',
        selection: [{ kind: 'all' }],
        where: { kind: 'and', preds: [] },
      }).sql,
    ).toContain('where 1')
  })

  it('rejects right joins, date_trunc and unsupported DDL', () => {
    expect(() =>
      sqliteCore.compile({
        kind: 'select',
        table: 'a',
        selection: [{ kind: 'all' }],
        joins: [
          {
            type: 'right',
            table: 'b',
            on: {
              kind: 'cmp',
              column: 'id',
              op: 'eq',
              right: { column: 'id', table: 'b' },
            },
          },
        ],
      }),
    ).toThrow(/right joins/)
    expect(() =>
      sqliteCore.compile({
        kind: 'select',
        table: 'a',
        selection: [
          {
            kind: 'expr',
            alias: 'day',
            expr: {
              kind: 'date_trunc',
              unit: 'day',
              arg: { kind: 'column', column: 'created' },
            },
          },
        ],
      }),
    ).toThrow(/date_trunc/)
    expect(() => sqliteCore.compile({ kind: 'create_schema', schema: 'x' })).toThrow(
      /does not support/,
    )
    expect(() =>
      sqliteCore.compile({
        kind: 'insert',
        table: 'a',
        columns: ['x'],
        values: [[undefined]],
      }),
    ).toThrow(/undefined/)
    expect(() =>
      sqliteCore.compile({
        kind: 'update',
        table: 'a',
        set: [{ column: 'x', value: undefined }],
        allowAll: true,
      }),
    ).toThrow(/undefined/)
    expect(() =>
      sqliteCore.compile({
        kind: 'create_table',
        table: 'a',
        columns: [
          {
            name: 'A',
            dataType: 'TEXT',
            notNull: false,
            unique: false,
            autoIncrement: false,
          },
          {
            name: 'a',
            dataType: 'TEXT',
            notNull: false,
            unique: false,
            autoIncrement: false,
          },
        ],
        primaryKey: [],
      }),
    ).toThrow(/duplicate/)
    expect(() =>
      sqliteCore.compile({
        kind: 'create_table',
        table: 'child',
        columns: [
          {
            name: 'parent_id',
            dataType: 'INTEGER',
            notNull: true,
            unique: false,
            autoIncrement: false,
            references: { schema: 'temp', table: 'parent', column: 'id' },
          },
        ],
        primaryKey: [],
      }),
    ).toThrow(/main/)
    expect(() =>
      sqliteCore.compile({
        kind: 'select',
        table: 'a',
        schema: 'temp',
        selection: [{ kind: 'all' }],
      }),
    ).toThrow(/main/)
    expect(() =>
      sqliteCore.compile({
        kind: 'select',
        table: 'a',
        selection: [{ kind: 'all' }],
        having: { kind: 'cmp', column: 'x', op: 'eq', value: 1 },
      }),
    ).toThrow(/GROUP BY/)
    expect(() =>
      sqliteCore.compile({
        kind: 'select',
        table: 'a',
        selection: [{ kind: 'all' }],
        where: { kind: 'cmp', column: 'x', op: 'eq' },
      }),
    ).toThrow(/exactly one/)
    expect(() =>
      sqliteCore.compile({
        kind: 'insert',
        table: 'a',
        columns: ['x'],
        values: [[undefined]],
      }),
    ).toThrow(/undefined/)
    expect(() =>
      sqliteCore.compile({
        kind: 'create_table',
        table: 'a',
        columns: [
          {
            name: 'id',
            dataType: 'INTEGER',
            notNull: true,
            unique: false,
            autoIncrement: false,
            generated: 'always',
          },
        ],
        primaryKey: ['id'],
      }),
    ).toThrow(/generated/)
  })

  it('uses SQLite affinity and preserves safe declared spelling', () => {
    expect(sqliteCore.normalizeDataType('varchar(255)')).toBe('TEXT')
    expect(sqliteCore.normalizeDataType('CUSTOM_BINARY')).toBe('NUMERIC')
    expect(normalizeSqliteDefaultExpression("'ABC''Def'")).toBe("'ABC''Def'")
    expect(
      sqliteCore.compile({
        kind: 'create_table',
        table: 'items',
        columns: [
          {
            name: 'id',
            dataType: 'INTEGER',
            notNull: true,
            unique: false,
            autoIncrement: true,
          },
        ],
        primaryKey: ['id'],
      }),
    ).toEqual({
      sql: 'create table "main"."items" ("id" INTEGER primary key autoincrement not null)',
      params: [],
    })
    expect(
      sqliteCore.compile({
        kind: 'create_index',
        table: 'items',
        name: 'idx_name',
        columns: ['name'],
        unique: false,
      }),
    ).toEqual({ sql: 'create index "main"."idx_name" on "items" ("name")', params: [] })
  })

  it('inlines the INTEGER primary key regardless of declared-type padding', () => {
    expect(
      sqliteCore.compile({
        kind: 'create_table',
        table: 'items',
        columns: [
          {
            name: 'id',
            dataType: ' INTEGER ',
            notNull: true,
            unique: false,
            autoIncrement: true,
          },
        ],
        primaryKey: ['id'],
      }),
    ).toEqual({
      sql: 'create table "main"."items" ("id" INTEGER primary key autoincrement not null)',
      params: [],
    })
    expect(
      sqliteCore.compile({
        kind: 'create_table',
        table: 'items',
        columns: [
          {
            name: 'id',
            dataType: 'INTEGER ',
            notNull: true,
            unique: false,
            autoIncrement: false,
          },
        ],
        primaryKey: ['id'],
      }),
    ).toEqual({
      sql: 'create table "main"."items" ("id" INTEGER primary key not null)',
      params: [],
    })
  })

  it('infers logical kinds and maps boolean/date/JSON values', () => {
    expect(sqliteCore.inferColumnType(string())).toBe('TEXT')
    expect(sqliteCore.inferColumnType(number())).toBe('REAL')
    expect(sqliteCore.inferColumnType(pipe(number(), integer()))).toBe('INTEGER')
    expect(sqliteCore.inferColumnType(blob())).toBe('BLOB')
    expect(sqliteCore.inferColumnType(boolean())).toBe('INTEGER')
    expect(sqliteCore.inferColumnType(date())).toBe('TEXT')
    expect(sqliteCore.inferColumnType(object({ name: string() }))).toBe('TEXT')
    expect(sqliteCore.inferColumnType(bigint())).toBe('INTEGER')
    const bool = pipe(boolean(), column({}))
    expect(
      sqliteCore.mapParamValueContext?.({ dataType: 'INTEGER', schema: bool }, true),
    ).toBe(1)
    expect(
      sqliteCore.mapResultValueContext?.({ dataType: 'INTEGER', schema: bool }, 0),
    ).toBe(false)
    expect(
      sqliteCore.mapResultValueContext?.({ dataType: 'INTEGER', schema: bool }, 1),
    ).toBe(true)
    expect(
      sqliteCore.mapResultValueContext?.({ dataType: 'INTEGER', schema: bool }, null),
    ).toBeNull()
    expect(
      sqliteCore.mapResultValueContext?.({ dataType: 'TEXT', schema: string() }, 'Plain'),
    ).toBe('Plain')
    const nullableDate = nullable(date())
    expect(
      sqliteCore.mapParamValueContext?.(
        { dataType: 'TEXT', schema: nullableDate },
        new Date('2024-01-01T00:00:00.000Z'),
      ),
    ).toBe('2024-01-01 00:00:00.000')
    expect(
      (
        sqliteCore.mapResultValueContext!(
          { dataType: 'TEXT', schema: nullableDate },
          '2024-01-01 00:00:00',
        ) as Date
      ).getTime(),
    ).toBe(Date.parse('2024-01-01T00:00:00.000Z'))
    // Written dates must sort against current_timestamp defaults byte-wise.
    const written = sqliteCore.mapParamValueContext!(
      { dataType: 'TEXT', schema: nullableDate },
      new Date('2024-01-01T00:00:01.000Z'),
    ) as string
    expect(written > '2024-01-01 00:00:00').toBe(true)
    expect(written < '2024-01-01 00:00:02').toBe(true)
    expect(
      (
        sqliteCore.mapResultValueContext!(
          { dataType: 'TEXT', schema: nullableDate },
          written,
        ) as Date
      ).toISOString(),
    ).toBe('2024-01-01T00:00:01.000Z')
    const big = bigint()
    expect(
      sqliteCore.mapResultValueContext?.({ dataType: 'INTEGER', schema: big }, '42'),
    ).toBe(42n)
    expect(
      sqliteCore.mapResultValueContext?.({ dataType: 'INTEGER', schema: big }, 42),
    ).toBe(42n)
    expect(
      sqliteCore.mapResultValueContext?.({ dataType: 'INTEGER', schema: big }, 42n),
    ).toBe(42n)
    expect(() =>
      sqliteCore.mapResultValueContext!({ dataType: 'INTEGER', schema: big }, 1.5),
    ).toThrow(/not an integer/i)
    expect(() =>
      sqliteCore.mapResultValueContext!({ dataType: 'INTEGER', schema: big }, '12e3'),
    ).toThrow(/not an integer/i)
    expect(
      sqliteCore.mapParamValueContext?.({ dataType: 'INTEGER', schema: big }, 42n),
    ).toBe(42n)
    expect(() =>
      sqliteCore.mapResultValueContext!(
        { dataType: 'INTEGER', schema: big },
        Number.MAX_SAFE_INTEGER + 2,
      ),
    ).toThrow(/unsafe integer/)
    const json = object({ name: string() })
    expect(
      sqliteCore.mapParamValueContext?.(
        { dataType: 'TEXT', schema: json },
        { name: 'Ada' },
      ),
    ).toBe('{"name":"Ada"}')
  })

  it('maps registered reference logical contexts and preserves override precedence', () => {
    const Target = defineTable(
      'mapping_targets',
      {
        id: pipe(boolean(), column({ unique: true })),
        payload: pipe(object({ name: string() }), column({ unique: true })),
      },
      { primaryKey: 'id' },
    )
    const Source = defineTable(
      'mapping_sources',
      {
        boolRef: reference(Target, 'id'),
        jsonRef: reference(Target, 'payload'),
        plain: string(),
        override: pipe(string(), column({ mapParam: () => 'column' })),
      },
      { primaryKey: 'plain' },
    )
    const global = createValueMapper(sqliteCore, { mapParamValue: () => 'global' }, [
      Source,
      Target,
    ])
    expect(global.mapParam(Source, 'boolRef', true)).toBe('global')
    const mapper = createValueMapper(sqliteCore, undefined, [Source, Target])
    expect(mapper.mapResultValue(Source, 'boolRef', 0)).toBe(false)
    expect(mapper.mapParam(Source, 'jsonRef', { name: 'Ada' })).toBe('{"name":"Ada"}')
    expect(mapper.mapResultValue(Source, 'jsonRef', '{"name":"Ada"}')).toEqual({
      name: 'Ada',
    })
    expect(mapper.mapParam(Source, 'override', 'x')).toBe('column')
    expect(mapper.mapParam(Source, 'plain', 'x')).toBe('x')
  })

  it('lowers complete main-database desired graphs with reference propagation', () => {
    const Parent = defineTable(
      'parents',
      { id: pipe(number(), column({ physicalType: { sqlite: 'INTEGER' } })) },
      { primaryKey: 'id' },
    )
    const Child = defineTable(
      'children',
      {
        id: number(),
        parentId: pipe(
          reference(Parent, 'id'),
          column({ physicalType: { sqlite: 'integer' } }),
        ),
      },
      { primaryKey: 'id' },
    )
    const graph = registerDesiredSchema([Child, Parent], identity)
    const lowered = lowerDesiredSchema([Child, Parent], identity, sqliteCore)
    expect(lowered.tables).toHaveLength(2)
    const child = lowered.tables.find((table) => table.ast.table === 'children')!
    expect(child.ast.columns.find((column) => column.name === 'parentId')?.dataType).toBe(
      'integer',
    )
    expect(
      child.ast.columns.find((column) => column.name === 'parentId')?.references,
    ).toEqual({ table: 'parents', column: 'id' })
    expect(sqliteCore.compile(child.ast).sql).toContain('references "parents" ("id")')
    expect(
      sqliteCore
        .lowerDesiredSchema({ tables: [...graph.tables].reverse() })
        .tables.map((table) => table.ast.table),
    ).toEqual(['children', 'parents'])
    const mapper = createValueMapper(sqliteCore, undefined, [Child, Parent])
    expect(mapper.columnTypes(Child).parentId).toBe('INTEGER')
  })

  it('lowers defaults, rowid autoincrement, FK actions, and rejects unsupported generation', () => {
    const Parent = defineTable(
      'default_parents',
      {
        id: pipe(
          number(),
          integer(),
          column({
            generation: {
              kind: 'dialectGeneration',
              dialect: 'sqlite',
              generation: 'AUTOINCREMENT',
            },
          }),
        ),
      },
      { primaryKey: 'id' },
    )
    const Child = defineTable(
      'default_children',
      {
        id: number(),
        parentId: nullable(
          reference(Parent, 'id', { onDelete: 'cascade', onUpdate: 'set null' }),
        ),
        label: pipe(
          string(),
          column({ databaseDefault: { kind: 'literal', value: "ABC'Def" } }),
        ),
        stamp: pipe(
          string(),
          column({
            readonly: true,
            databaseDefault: {
              kind: 'portableExpression',
              expression: 'currentTimestamp',
            },
          }),
        ),
      },
      { primaryKey: 'id' },
    )
    const lowered = lowerDesiredSchema([Child, Parent], identity, sqliteCore)
    const parent = lowered.tables.find((table) => table.ast.table === 'default_parents')!
    expect(parent.ast.columns[0]!.autoIncrement).toBe(true)
    const child = lowered.tables.find((table) => table.ast.table === 'default_children')!
    expect(
      child.ast.columns.find((column) => column.name === 'label')?.databaseDefault?.sql,
    ).toBe("'ABC''Def'")
    expect(
      child.ast.columns.find((column) => column.name === 'stamp')?.databaseDefault?.sql,
    ).toBe('current_timestamp')
    expect(
      child.ast.columns.find((column) => column.name === 'parentId')?.references,
    ).toMatchObject({ onDelete: 'cascade', onUpdate: 'set null' })
    const Bad = defineTable(
      'bad_generation',
      {
        id: pipe(string(), column({ generation: { kind: 'identity', mode: 'always' } })),
      },
      { primaryKey: 'id' },
    )
    expect(() => lowerDesiredSchema([Bad], identity, sqliteCore)).toThrow(
      /identity generation/,
    )
    const Computed = defineTable(
      'computed_generation',
      {
        id: pipe(
          string(),
          column({
            generation: {
              kind: 'computed',
              expression: { kind: 'portableExpression', expression: 'currentDate' },
              storage: 'stored',
            },
          }),
        ),
      },
      { primaryKey: 'id' },
    )
    expect(() => lowerDesiredSchema([Computed], identity, sqliteCore)).toThrow(
      /computed generation/,
    )
    const Incompatible = defineTable(
      'incompatible_ref',
      {
        id: pipe(string(), column({ physicalType: { sqlite: 'TEXT' } })),
        parentId: pipe(
          reference(Parent, 'id'),
          column({ physicalType: { sqlite: 'TEXT' } }),
        ),
      },
      { primaryKey: 'id' },
    )
    expect(() =>
      lowerDesiredSchema([Incompatible, Parent], identity, sqliteCore),
    ).toThrow(/type/)
    const Commented = defineTable(
      'commented',
      { id: pipe(string(), column({ comment: 'unsupported' })) },
      { primaryKey: 'id' },
    )
    expect(() => lowerDesiredSchema([Commented], identity, sqliteCore)).toThrow(
      /unsupported metadata/,
    )
    const OnUpdate = defineTable(
      'on_update',
      { id: pipe(string(), column({ onUpdate: 'now()' })) },
      { primaryKey: 'id' },
    )
    expect(() => lowerDesiredSchema([OnUpdate], identity, sqliteCore)).toThrow(
      /unsupported metadata/,
    )
    const WrongDefault = defineTable(
      'wrong_default',
      {
        id: pipe(
          string(),
          column({
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
    expect(() => lowerDesiredSchema([WrongDefault], identity, sqliteCore)).toThrow(
      /tagged for dialect/,
    )
  })

  it('exposes production SQLite naming without registering the dialect', () => {
    expect(physicalNamingProfile('sqlite')).toBe(SQLITE_PHYSICAL_NAMING)
    expect(SQLITE_PHYSICAL_NAMING.id).toBe('sqlite')
    const users = identity.resolve({ relation: 'Users' })
    const posts = identity.resolve({ relation: 'posts' })
    const registry = createPhysicalNameRegistry(SQLITE_PHYSICAL_NAMING)
    registry.reserve({
      kind: 'index',
      owner: users,
      name: 'shared_idx',
      token: 'users',
      description: 'users index',
    })
    expect(() =>
      registry.reserve({
        kind: 'index',
        owner: posts,
        name: 'SHARED_IDX',
        token: 'posts',
        description: 'posts index',
      }),
    ).toThrow(/collision/i)
    const first = generatedIndexName(users, ['a_b', 'c'], false, SQLITE_PHYSICAL_NAMING)
    expect(generatedIndexName(users, ['a_b', 'c'], false, SQLITE_PHYSICAL_NAMING)).toBe(
      first,
    )
    expect(
      generatedIndexName(users, ['a', 'b_c'], false, SQLITE_PHYSICAL_NAMING),
    ).not.toBe(first)
    expect(() => resolveDialect('sqlite')).toThrow(/unsupported connector dialect/)
  })
})
