import { baseTable } from '@/defineTable'
import type { SelectItemAst } from '@/dialects'
import { isSqlNullable } from '@/schemas'
import type { ColumnRef, Prettify, TableHandle } from '@/types'
import { InvariantError, QueryError } from '@/utils/error'

import { candidateKeys } from './candidateKeys'
import { isColumnRef } from './expressions'
import type { ValueMapper } from './mapping'

/** Describes one table occurrence and the relation fields to attach to each result. */
type NestedProjection = {
  readonly key: readonly [ColumnRef, ...ColumnRef[]]
  readonly select: Readonly<Record<string, ColumnRef>>
  readonly one?: Readonly<Record<string, NestedProjection>>
  readonly many?: Readonly<Record<string, NestedProjection>>
}

type ChildResults<T, K extends 'one' | 'many'> = {
  -readonly [Name in keyof T as Name extends symbol ? never : Name]: K extends 'one'
    ? NestedResult<T[Name]> | null
    : NestedResult<T[Name]>[]
}

type NestedChildren<T, K extends 'one' | 'many'> =
  T extends Record<K, infer Children>
    ? ChildResults<Children, K>
    : K extends keyof T
      ? Partial<ChildResults<NonNullable<T[K]>, K>>
      : unknown

type FieldResult<T> = T extends ColumnRef<string, string, infer V> ? V : never

/** Infers the fields and relation cardinalities from a nested projection. */
type NestedResult<T> = T extends { readonly select: infer Fields }
  ? string extends keyof Fields
    ? Row
    : Prettify<
        {
          -readonly [K in keyof Fields as K extends symbol ? never : K]: FieldResult<
            Fields[K]
          >
        } & NestedChildren<T, 'one'> &
          NestedChildren<T, 'many'>
      >
  : never

type ResolvedColumn = { handle: TableHandle; column: string }
type ResolveColumn = (ref: ColumnRef) => ResolvedColumn
type AddColumn = (source: ResolvedColumn) => string
type Row = Record<string, unknown>
type ResultNode = { value: Row; children: Map<string, NodeByKey> }
type NodeByKey = Map<string, ResultNode>
type PreparedField = { name: string; alias: string; column: string }
type PreparedChild = { name: string; many: boolean; node: PreparedNode }

type PreparedNode = {
  handle: TableHandle
  key: string[]
  fields: PreparedField[]
  children: PreparedChild[]
}

/** Checks key ownership, uniqueness and non-nullability against the declared schema. */
function resolveKey(
  key: NestedProjection['key'],
  resolve: ResolveColumn,
  root: TableHandle | undefined,
): { handle: TableHandle; columns: ResolvedColumn[] } {
  if (!Array.isArray(key) || key.length === 0 || !key.every(isColumnRef)) {
    throw new QueryError({
      message: 'executeNested requires a nonempty key of column references',
    })
  }

  const columns = key.map(resolve)
  const { handle } = columns[0]

  if (root && handle !== root) {
    throw new QueryError({
      message: 'executeNested root key must belong to the table in from(...)',
    })
  }

  const names = new Set(columns.map(({ column }) => column))
  const entries = handle.getSchema().entries

  if (
    names.size !== columns.length ||
    columns.some(
      ({ handle: owner, column }) => owner !== handle || isSqlNullable(entries[column]),
    ) ||
    !candidateKeys(handle).some(
      (candidate) =>
        candidate.length === names.size && candidate.every((name) => names.has(name)),
    )
  ) {
    throw new QueryError({
      message:
        'executeNested key must match a non-null candidate key of one table occurrence',
    })
  }

  return { handle, columns }
}

/** Builds one SQL projection with private aliases and records how to shape its rows. */
function prepareNestedProjection(
  projection: NestedProjection,
  root: TableHandle,
  resolve: ResolveColumn,
): {
  selection: SelectItemAst[]
  materialize: (rows: unknown[], mapper?: ValueMapper) => Row[]
} {
  const selection: SelectItemAst[] = []
  const aliases = new Map<TableHandle, Map<string, string>>()

  const addColumn = ({ handle, column }: ResolvedColumn) => {
    const columns = aliases.get(handle) ?? new Map<string, string>()
    aliases.set(handle, columns)

    const previous = columns.get(column)

    if (previous !== undefined) return previous

    const alias = `__stratom_nested${selection.length}`
    columns.set(column, alias)

    selection.push({
      kind: 'column',
      relation: handle.getTableMetadata().relation,
      column,
      alias,
    })

    return alias
  }

  const node = prepareNode(projection, resolve, addColumn, root)
  return { selection, materialize: (rows, mapper) => materializeRows(node, rows, mapper) }
}

/** Validates and prepares the fields and children of one result node. */
function prepareNode(
  input: NestedProjection,
  resolve: ResolveColumn,
  addColumn: AddColumn,
  root?: TableHandle,
): PreparedNode {
  const { handle, columns } = resolveKey(input.key, resolve, root)

  const fields = Object.entries(input.select).map(([name, ref]) => {
    if (!isColumnRef(ref)) {
      throw new QueryError({
        message: 'executeNested select requires column references',
      })
    }

    const source = resolve(ref)

    if (source.handle !== handle) {
      throw new QueryError({
        message: `executeNested field "${name}" must belong to the same table occurrence as its key`,
      })
    }

    return { name, alias: addColumn(source), column: source.column }
  })

  const children = [
    ...Object.entries(input.one ?? {}).map(([name, child]) => ({
      name,
      child,
      many: false,
    })),
    ...Object.entries(input.many ?? {}).map(([name, child]) => ({
      name,
      child,
      many: true,
    })),
  ]

  const names = [...fields, ...children].map(({ name }) => name)

  if (new Set(names).size !== names.length) {
    throw new QueryError({
      message: 'executeNested output field names must be unique in each node',
    })
  }

  return {
    handle: baseTable(handle),
    key: columns.map(addColumn),
    fields,
    children: children.map(({ name, child, many }) => ({
      name,
      many,
      node: prepareNode(child, resolve, addColumn),
    })),
  }
}

/** Encodes native key values by type so distinct values always have distinct encodings. */
function encodeKeyValue(value: unknown): string {
  if (typeof value === 'string') return `string:${value}`
  if (typeof value === 'number') return `number:${value}`
  if (typeof value === 'bigint') return `bigint:${value}`
  if (typeof value === 'boolean') return `boolean:${value}`
  if (value instanceof Uint8Array) return `bytes:${Array.from(value).join(',')}`

  throw new QueryError({
    message:
      'executeNested keys must use string, number, bigint, boolean, or binary database values',
  })
}

/** Reads identity before custom result mapping can change key equality or null values. */
function rowKey(node: PreparedNode, row: Row): string | undefined {
  const values = node.key.map((alias) => row[alias])

  if (values.every((value) => value === null)) return undefined

  if (values.some((value) => value == null)) {
    throw new InvariantError('executeNested received an incomplete key from the database')
  }

  return JSON.stringify(values.map(encodeKeyValue))
}

/** Builds a first-seen node, then merges each row's children into the same node. */
function mergeNode(
  node: PreparedNode,
  key: string,
  row: Row,
  nodes: NodeByKey,
  mapper?: ValueMapper,
): ResultNode {
  let result = nodes.get(key)

  if (!result) {
    result = {
      value: Object.fromEntries([
        ...node.fields.map(
          ({ name, alias, column }) =>
            [
              name,
              mapper
                ? mapper.mapResultValue(node.handle, column, row[alias])
                : row[alias],
            ] as const,
        ),
        ...node.children.map(({ name, many }) => [name, many ? [] : null] as const),
      ]),
      children: new Map(node.children.map(({ name }) => [name, new Map()])),
    }
    nodes.set(key, result)
  }

  for (const child of node.children) {
    const childKey = rowKey(child.node, row)

    if (childKey === undefined) continue

    const siblings = result.children.get(child.name)!
    const first = !siblings.has(childKey)

    if (first && !child.many && siblings.size > 0) {
      throw new QueryError({
        message: `executeNested one relation "${child.name}" matched multiple keys`,
      })
    }

    const value = mergeNode(child.node, childKey, row, siblings, mapper).value

    if (!first) continue

    const current = result.value[child.name]

    if (Array.isArray(current)) current.push(value)
    else result.value[child.name] = value
  }

  return result
}

/** Groups raw SQL rows into root results in first-occurrence order. */
function materializeRows(
  node: PreparedNode,
  rows: unknown[],
  mapper?: ValueMapper,
): Row[] {
  const roots: NodeByKey = new Map()
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new InvariantError('executeNested expected an object row from the database')
    }

    const record = row as Row
    const key = rowKey(node, record)

    if (key === undefined) {
      throw new InvariantError('executeNested received a null root key from the database')
    }

    mergeNode(node, key, record, roots, mapper)
  }

  return Array.from(roots.values(), ({ value }) => value)
}

export { prepareNestedProjection }
export type { NestedProjection, NestedResult }
