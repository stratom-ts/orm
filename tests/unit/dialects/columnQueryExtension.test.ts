import { pipe, string } from 'valibot'
import { expect, it } from 'vitest'

import { defineDialect } from '@/dialects/defineDialect'
import type { DialectQuery, DialectQueryResolution, SqlAst } from '@/dialects/types'
import { column, defineTable, postgresDialect } from '@/index'
import type { RelationIdentityInput } from '@/schemas'
import type { TableHandle } from '@/types'

class ClassResolution implements DialectQueryResolution {
  constructor(readonly handles: readonly TableHandle[]) {}
  compile(node: SqlAst) {
    return { sql: JSON.stringify(node), params: [] }
  }
  findRelationMatches(relation: RelationIdentityInput, candidates = this.handles) {
    return candidates.filter(
      (handle) => handle.getTableMetadata().name === relation.relation,
    )
  }
  findColumnMatches(handle: TableHandle, column: string) {
    return Object.keys(handle.getSchema().entries).filter((name) => name === column)
  }
}

class ClassQuery implements DialectQuery {
  #prefix = 'class'
  resolve(handles: readonly TableHandle[]) {
    return new ClassResolution(handles)
  }
  mapParamValue(_type: string, value: unknown) {
    return `${this.#prefix}:${String(value)}`
  }
  mapResultValue(_type: string, value: unknown) {
    return `${this.#prefix}:${String(value)}`
  }
}

it('preserves prototype query methods and instance binding in extension dialects', () => {
  const { migration, ...facets } = postgresDialect
  const dialect = defineDialect({
    ...facets,
    query: new ClassQuery(),
    lower: migration.lower,
    execute: migration.execute,
  })

  const Records = defineTable(
    'class_columns',
    { application: pipe(string(), column({ name: 'stored' })) },
    { primaryKey: 'application' },
  )

  const query = dialect.query.resolve([Records])
  expect(query.findColumnMatches(Records, 'application')).toEqual(['application'])

  expect(
    query.compile({
      kind: 'select',
      relation: { relation: 'class_columns' },
      selection: [{ kind: 'all' }],
    }).sql,
  ).toContain('"column":"stored"')

  expect(dialect.query.mapParamValue?.('text', 'x')).toBe('class:x')
  expect(dialect.query.mapResultValue?.('text', 'x')).toBe('class:x')
})
