import type { SelectAst } from '@/dialects'
import { QueryError } from '@/utils/error'

/** Private authored query metadata. Executors and mapping functions never enter the AST. */
const selectDefinitions = new WeakMap<object, { owner: object; build(): SelectAst }>()
const nestedDefinitions = new WeakMap<object, object>()

function nestedQuery(builder: object): SelectAst {
  if (!selectDefinitions.has(builder))
    throw new QueryError({ message: 'Subqueries require a select builder' })

  const placeholder: SelectAst = {
    kind: 'select',
    relation: { relation: '' },
    selection: [],
  }

  nestedDefinitions.set(placeholder, builder)
  return placeholder
}

type SelectQuery<R = Record<string, unknown>> = { execute(): Promise<R[]> }
type QueryRow<Q> = Q extends SelectQuery<infer R> ? R : never
type ScalarValue<Q> = QueryRow<Q>[keyof QueryRow<Q>] | null

type ScalarExpression<T = unknown> = {
  readonly kind: 'scalar'
  readonly query: SelectAst
  readonly __value?: T
}

type SingleProjection<Q> = Q extends {
  readonly [projectionShape]?: infer P extends readonly unknown[]
}
  ? number extends P['length']
    ? unknown
    : P['length'] extends 1
      ? unknown
      : never
  : unknown

type IsUnion<T, C = T> = T extends C ? ([C] extends [T] ? false : true) : never

type WildcardProjection<R> = string extends keyof R
  ? readonly unknown[]
  : IsUnion<keyof R> extends true
    ? readonly [unknown, unknown]
    : readonly [unknown]

export declare const projectionShape: unique symbol

export type {
  SelectQuery,
  QueryRow,
  ScalarValue,
  ScalarExpression,
  SingleProjection,
  WildcardProjection,
}

export { selectDefinitions, nestedDefinitions, nestedQuery }
