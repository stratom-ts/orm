import { unknown } from 'valibot'

import type { DialectQueryResolution, SelectAst } from '@/dialects'
import type { CteHandle } from '@/types/cte'
import { cteAliases, cteHandles } from '@/types/cte'
import type { ReadSource } from '@/types/tableHandle'
import { QueryError } from '@/utils/error'

import type { Combined, Compatible, OutputName, Shape } from './compound'
import { cteOutputNames, cteOutputSources, prepareSelectProjection } from './projection'
import type { QueryRow, SelectQuery, projectionShape } from './subquery'
import { selectDefinitions } from './subquery'

type CteOptions = { union?: 'all' | 'distinct' }

type Definition = {
  owner: object
  initial: object
  recursive?: object
  self?: ReadSource
  union?: 'all' | 'distinct'
  name: string
}

const cteAttachments = new WeakMap<object, readonly ReadSource[]>()
const recursiveSelfHandles = new WeakSet()
const cteDefinitions = new WeakMap<object, Definition>()

function cteBase(source: ReadSource): ReadSource {
  const base = cteAliases.get(source)
  return base ? cteBase(base) : source
}

type NamedOutputs<P extends readonly unknown[], Seen = never> = number extends P['length']
  ? unknown
  : P extends readonly [infer H, ...infer T]
    ? unknown extends H
      ? NamedOutputs<T, Seen>
      : OutputName<H> extends infer N extends string
        ? N extends Seen
          ? never
          : NamedOutputs<T, Seen | N>
        : never
    : unknown

type SelectOnly<Q> = typeof projectionShape extends keyof Q ? unknown : never

type CteMethods = {
  cte<const N extends string, Q extends SelectQuery<unknown>>(
    name: N,
    initial: Q & SelectOnly<Q> & NamedOutputs<Shape<Q>>,
  ): CteHandle<QueryRow<Q>, N>
  cte<
    const N extends string,
    Q extends SelectQuery<unknown>,
    R extends SelectQuery<unknown>,
  >(
    name: N,
    initial: Q & SelectOnly<Q> & NamedOutputs<Shape<Q>>,
    recursive: (
      self: CteHandle<{ [K in keyof QueryRow<Q>]: QueryRow<Q>[K] | null }, N>,
    ) => R & SelectOnly<R> & Compatible<QueryRow<Q>, Shape<Q>, R>,
    options?: CteOptions,
  ): CteHandle<Combined<QueryRow<Q>, QueryRow<R>>, N>
}

function authoredSelect(builder: object, owner: object): SelectAst {
  const definition = selectDefinitions.get(builder)

  if (!definition || definition.owner !== owner)
    throw new QueryError({
      message: 'CTEs require SELECT builders from the same client scope',
    })

  return definition.build()
}

function createCteMethods(
  owner: object,
  query: DialectQueryResolution,
  ensureOpen: () => void,
): CteMethods {
  const cte = (
    name: string,
    initial: object,
    recursive?: (self: CteHandle) => object,
    options?: CteOptions,
  ) => {
    ensureOpen()

    if (
      typeof name !== 'string' ||
      !name.length ||
      name.includes('\0') ||
      new TextEncoder().encode(name).length > 63 ||
      new TextDecoder().decode(new TextEncoder().encode(name)) !== name
    )
      throw new QueryError({ message: 'Invalid CTE name' })

    if (options?.union !== undefined && !['all', 'distinct'].includes(options.union))
      throw new QueryError({ message: 'Invalid recursive CTE union mode' })

    const projection = prepareSelectProjection(authoredSelect(initial, owner), query)
    const names = projection.outputs.map((o) => o.outputName)

    if (
      names.some((n) => !n) ||
      projection.node.selection.some((item) => item.kind === 'all')
    )
      throw new QueryError({ message: 'CTE computed outputs require aliases' })

    const source = outputHandle(name, projection, recursive !== undefined)
    const definition: Definition = { name, owner, initial, union: options?.union }

    cteDefinitions.set(source, definition)

    if (recursive) {
      recursiveSelfHandles.add(source)
      definition.self = source
      definition.recursive = recursive(source)
      authoredSelect(definition.recursive, owner)

      const published = outputHandle(name, projection, true)
      cteDefinitions.set(published, { ...definition, self: source })
      return published
    }

    return source
  }

  return { cte: cte }
}

/** Builds an output source without physical-table authority. */
function outputHandle(
  name: string,
  projection: ReturnType<typeof prepareSelectProjection>,
  recursive: boolean,
): CteHandle {
  const names = projection.outputs.map((o) => o.outputName)
  const relation = { relation: name, cte: true as const }
  const entries = Object.fromEntries(names.map((n) => [n, unknown()]))
  const handle = {
    getSchema: () => ({ entries }),
    getTableMetadata: () => ({ name, relation }),
  }

  for (const column of names) {
    if (Object.hasOwn(handle, column))
      throw new QueryError({ message: 'Reserved CTE output name' })

    Object.defineProperty(handle, column, {
      value: { relation, column, __type: undefined },
      enumerable: true,
    })
  }

  cteOutputSources.set(
    handle,
    new Map(
      projection.outputs.map((output, index) => {
        const source = projection.sources[index]
        return [
          output.outputName,
          source && (recursive || projection.node.compound)
            ? { ...source, bypassNull: true }
            : source,
        ]
      }),
    ),
  )

  cteOutputNames.set(relation, projection.outputs)
  cteHandles.add(handle)
  return handle as unknown as CteHandle
}

export type { CteMethods, CteOptions }
export {
  createCteMethods,
  authoredSelect,
  cteBase,
  cteAttachments,
  cteDefinitions,
  recursiveSelfHandles,
}
