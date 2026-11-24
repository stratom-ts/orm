import type { ColumnRef, Prettify } from '@/types'
import type { Equals as Equal } from '@/types/equals'

import type { CompiledQuery } from './compiled'
import type { QueryRow, SelectQuery, projectionShape } from './subquery'

type Known<T> = 0 extends 1 & T ? false : unknown extends T ? false : true

type CompatibleRows<L, R> =
  Equal<keyof L, keyof R> extends true
    ? false extends {
        [K in keyof L]: K extends keyof R
          ? Known<Exclude<L[K], null>> extends true
            ? Known<Exclude<R[K], null>> extends true
              ? Equal<Exclude<L[K], null>, Exclude<R[K], null>>
              : false
            : false
          : false
      }[keyof L]
      ? false
      : true
    : false

type OutputName<T> = T extends { alias: infer A extends string }
  ? A
  : T extends ColumnRef<string, infer C>
    ? C
    : T extends string
      ? T
      : T extends { column: infer C extends string }
        ? C
        : unknown

type Names<P extends readonly unknown[]> = { -readonly [K in keyof P]: OutputName<P[K]> }

type Shape<Q> = Q extends {
  readonly [projectionShape]?: infer P extends readonly unknown[]
}
  ? P
  : readonly unknown[]

type KnownNames<P extends readonly unknown[]> = number extends P['length']
  ? false
  : unknown extends Names<P>[number]
    ? false
    : true

type Compatible<L, P extends readonly unknown[], Q> =
  CompatibleRows<L, QueryRow<Q>> extends true
    ? KnownNames<P> extends true
      ? KnownNames<Shape<Q>> extends true
        ? Equal<Names<P>, Names<Shape<Q>>> extends true
          ? unknown
          : never
        : unknown
      : unknown
    : never

type Combined<L, R> = Prettify<{
  [K in keyof L]: L[K] | (K extends keyof R ? R[K] : never)
}>

/** Fluent set operations capture each complete operand without changing it. */
export type SetOperations<R, P extends readonly unknown[]> = {
  union<Q extends SelectQuery<unknown>>(
    other: Q & Compatible<R, P, Q>,
  ): CompoundSelectBuilder<Combined<R, QueryRow<Q>>, P>
  unionAll<Q extends SelectQuery<unknown>>(
    other: Q & Compatible<R, P, Q>,
  ): CompoundSelectBuilder<Combined<R, QueryRow<Q>>, P>
  intersect<Q extends SelectQuery<unknown>>(
    other: Q & Compatible<R, P, Q>,
  ): CompoundSelectBuilder<Combined<R, QueryRow<Q>>, P>
  except<Q extends SelectQuery<unknown>>(
    other: Q & Compatible<R, P, Q>,
  ): CompoundSelectBuilder<R, P>
}

/** A complete SQL set expression, ordered and paginated by its selected output names. */
export type CompoundSelectBuilder<
  TResult,
  P extends readonly unknown[] = readonly unknown[],
> = SetOperations<TResult, P> & {
  readonly [projectionShape]?: P
  orderBy(
    outputName: Extract<keyof TResult, string>,
    direction?: 'asc' | 'desc',
    nulls?: 'first' | 'last',
  ): CompoundSelectBuilder<TResult, P>
  limit(count: number): CompoundSelectBuilder<TResult, P>
  offset(count: number): CompoundSelectBuilder<TResult, P>
  compile(): CompiledQuery
  execute(): Promise<Prettify<TResult>[]>
  executeTakeFirst(): Promise<TResult | undefined>
  executeTakeFirstOrThrow(): Promise<TResult>
}
