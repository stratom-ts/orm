import { number, pipe } from 'valibot'
import { describe, expect, it } from 'vitest'

import { compilePostgresQuery } from '@/dialects/postgres/compile'
import { compileSqliteQuery } from '@/dialects/sqlite/compile'
import type { CteRelationAst, SelectAst } from '@/dialects/types'
import { column, defineTable, postgresDialect, sqliteDialect } from '@/index'
import { QueryError } from '@/utils/error'

const source = { relation: 'nodes' }
const team: CteRelationAst = { relation: 'team', cte: true }

function initial(): SelectAst {
  return {
    kind: 'select',
    relation: source,
    selection: [{ kind: 'column', column: 'id' }],
    where: { kind: 'cmp', column: 'id', op: 'eq', value: 1 },
  }
}

function recursive(): SelectAst {
  return {
    kind: 'select',
    relation: source,
    selection: [{ kind: 'column', column: 'id', relation: source }],
    joins: [
      {
        type: 'inner',
        relation: team,
        on: {
          kind: 'cmp',
          column: 'parent',
          relation: source,
          op: 'eq',
          right: { column: 'id', relation: team },
        },
      },
    ],
    where: { kind: 'cmp', column: 'id', relation: source, op: 'lt', value: 10 },
  }
}

function statement(union: 'all' | 'distinct' = 'all'): SelectAst {
  return {
    kind: 'select',
    relation: team,
    selection: [{ kind: 'column', column: 'id', relation: team }],
    with: [
      {
        name: 'team',
        columns: ['id'],
        initial: initial(),
        recursive: { query: recursive(), union },
      },
    ],
    where: { kind: 'cmp', column: 'id', relation: team, op: 'gt', value: 2 },
  }
}

const unsupportedShapes = [
  ['ordering', { orderBy: [{ column: 'id', direction: 'asc' }] }],
  ['pagination', { limit: 1 }],
  ['grouping', { groupBy: [{ column: 'id' }] }],
  [
    'aggregate',
    { selection: [{ kind: 'expr', expr: { kind: 'count_all' }, alias: 'id' }] },
  ],
  ['multiple self sources', { relation: team }],
  [
    'outer join',
    {
      joins: [
        {
          type: 'left',
          relation: team,
          on: { kind: 'cmp', column: 'id', op: 'eq', value: 1 },
        },
      ],
    },
  ],
  [
    'nested self',
    {
      where: {
        kind: 'exists',
        query: { kind: 'select', relation: team, selection: [{ kind: 'all' }] },
      },
    },
  ],
] satisfies readonly (readonly [string, Partial<SelectAst>])[]

describe.each([
  ['PostgreSQL', compilePostgresQuery],
  ['SQLite', compileSqliteQuery],
] as const)('%s WITH compiler', (_, compile) => {
  it('should emit direct recursive terms with statement-wide ordered bindings and reusable ASTs', () => {
    const ast = statement()
    const before = structuredClone(ast)
    const compiled = compile(ast)
    expect(compiled.params).toEqual([1, 10, 2])
    expect(compiled.sql).toMatch(/^with recursive "team" \("id"\) as \(select /)
    expect(compiled.sql).toContain(' union all select ')
    expect(compiled.sql).not.toContain('__stratom_set_')
    expect(compiled.sql).toContain('join "team" as ')
    expect(compiled.sql).not.toContain('join "main"."team"')
    expect(compile(ast)).toEqual(compiled)
    expect(ast).toEqual(before)
  })
})

describe.each([
  ['PostgreSQL', compilePostgresQuery],
  ['SQLite', compileSqliteQuery],
] as const)('%s ordinary WITH compiler', (_, compile) => {
  it('should emit explicit UNION without changing ordinary set-operation wrapping', () => {
    expect(compile(statement('distinct')).sql).toContain(' union select ')
    const ast: SelectAst = {
      ...initial(),
      compound: { operator: 'union all', left: initial(), right: initial() },
    }

    expect(compile(ast).sql).toContain('__stratom_set_l')
  })

  it('should quote names and emit ordinary dependency definitions before the consumer', () => {
    const first: CteRelationAst = { relation: 'first"part', cte: true }
    const last: CteRelationAst = { relation: 'last.part', cte: true }
    const ast: SelectAst = {
      kind: 'select',
      relation: last,
      selection: [{ kind: 'all' }],
      with: [
        { name: first.relation, columns: ['id'], initial: initial() },
        {
          name: last.relation,
          columns: ['id'],
          initial: {
            kind: 'select',
            relation: first,
            selection: [{ kind: 'column', column: 'id' }],
          },
        },
      ],
    }

    const compiled = compile(ast)
    expect(compiled.sql).toMatch(/^with "first""part"/)
    expect(compiled.sql).toContain(', "last.part" ("id") as (select ')
    expect(compiled.sql).toContain('from "last.part" as ')
    expect(compiled.params).toEqual([1])
  })
})

describe.each([
  ['PostgreSQL', compilePostgresQuery],
  ['SQLite', compileSqliteQuery],
] as const)('%s recursive shape validation', (_, compile) => {
  it.each(unsupportedShapes)(
    'should reject unsupported recursive %s before SQL execution',
    (_, patch) => {
      const ast: SelectAst = {
        ...statement(),
        with: [
          {
            name: 'team',
            columns: ['id'],
            initial: initial(),
            recursive: { union: 'all', query: { ...recursive(), ...patch } },
          },
        ],
      }

      expect(() => compile(ast)).toThrow(QueryError)
    },
  )

  it('should reject self in the initial term and duplicate definition names', () => {
    const definition = statement().with![0]
    expect(() =>
      compile({
        ...statement(),
        with: [{ ...definition, initial: { ...initial(), relation: team } }],
      }),
    ).toThrow(/initial term/)

    expect(() => compile({ ...statement(), with: [definition, definition] })).toThrow(
      /unique/,
    )
  })
})

it('should number PostgreSQL placeholders across definitions, recursive terms, and the consumer', () => {
  const sql = compilePostgresQuery(statement()).sql
  expect(sql.match(/\$\d+/g)).toEqual(['$1', '$2', '$3'])
})

it('should preserve physical PostgreSQL session requirements nested inside a definition', () => {
  const databaseSource = {
    relation: 'nodes',
    namespace: [
      { role: 'database', spelling: 'expected' },
      { role: 'schema', spelling: 'public' },
    ] as const,
  }

  const ast: SelectAst = {
    kind: 'select',
    relation: team,
    selection: [{ kind: 'all' }],
    with: [
      {
        name: 'team',
        columns: ['id'],
        initial: { ...initial(), relation: databaseSource },
      },
    ],
  }

  const compiled = compilePostgresQuery(ast)
  expect(() => compiled.assertSession?.({ database: 'wrong' })).toThrow(QueryError)
  expect(() => compiled.assertSession?.({ database: 'expected' })).not.toThrow()
})

it.each([postgresDialect, sqliteDialect])(
  'should lower physical columns inside definitions without resolving CTEs as registered tables ($id)',
  (dialect) => {
    const Physical = defineTable(
      'team',
      {
        id: pipe(number(), column({ name: 'physical_id' })),
      },
      { primaryKey: 'id' },
    )

    const ast: SelectAst = {
      kind: 'select',
      relation: team,
      selection: [{ kind: 'column', column: 'id', relation: team }],
      with: [
        {
          name: 'team',
          columns: ['id'],
          initial: {
            kind: 'select',
            relation: Physical.getTableMetadata().relation,
            selection: [{ kind: 'column', column: 'id' }],
          },
        },
      ],
    }

    const compiled = dialect.query.resolve([Physical]).compile(ast)
    expect(compiled.sql.match(/"physical_id"/g)).toEqual(['"physical_id"'])
    expect(compiled.sql).toContain('from "__stratom_cte0" as ')
  },
)
