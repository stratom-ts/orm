import type { InferInput, InferOutput } from 'valibot'
import { number, object, pipe, string, title, toNumber } from 'valibot'
import { expectTypeOf, it } from 'vitest'

import type { ReferenceTarget } from '@/index'
import { defineTable, reference, table } from '@/index'

it('infers lazy handle and raw-schema keys while preserving local input and output', () => {
  const Target = defineTable(
    'target',
    { id: pipe(string(), toNumber()) },
    { primaryKey: 'id' },
  )

  const ref = reference(pipe(string(), toNumber()), () => Target, 'id')
  expectTypeOf<InferInput<typeof ref>>().toEqualTypeOf<string>()
  expectTypeOf<InferOutput<typeof ref>>().toEqualTypeOf<number>()
  const raw = pipe(
    object({ id: number() }),
    title('raw'),
    table({ name: 'raw', primaryKey: 'id' }),
  )

  const rawRef = reference(number(), () => raw, 'id')
  expectTypeOf<InferOutput<typeof rawRef>>().toEqualTypeOf<number>()

  // @ts-expect-error Missing keys cannot be referenced.
  reference(number(), () => raw, 'missing')

  // @ts-expect-error A local string cannot reference a numeric column.
  reference(string(), () => raw, 'id')

  // @ts-expect-error The local schema must retain the target input contract.
  reference(number(), () => Target, 'id')
})

const idColumns = { id: string() }

type IdTarget = ReferenceTarget<typeof idColumns>

it('checks narrow target contracts across genuinely circular declarations', () => {
  const A = defineTable(
    'a',
    {
      ...idColumns,
      bId: (() => {
        // @ts-expect-error The circular target contract exposes no missing key.
        reference(string(), (): IdTarget => B, 'missing')
        return reference(string(), (): IdTarget => B, 'id')
      })(),
    },
    { primaryKey: 'id' },
  )

  const B = defineTable(
    'b',
    {
      ...idColumns,
      count: number(),
      aId: (() => {
        // @ts-expect-error A circular string key rejects a numeric local schema.
        reference(number(), (): IdTarget => A, 'id')
        return reference(string(), (): IdTarget => A, 'id')
      })(),
    },
    { primaryKey: 'id' },
  )

  expectTypeOf(A.bId.__type).toEqualTypeOf<string>()
  expectTypeOf(B.aId.__type).toEqualTypeOf<string>()
  expectTypeOf(B.count.__type).toEqualTypeOf<number>()

  expectTypeOf<
    InferInput<ReturnType<typeof A.getSchema>['entries']['bId']>
  >().toEqualTypeOf<string>()

  expectTypeOf<
    InferOutput<ReturnType<typeof B.getSchema>['entries']['aId']>
  >().toEqualTypeOf<string>()
})

it('checks a generic raw-schema target and retains transformed input and output', () => {
  const columns = { id: pipe(string(), toNumber()) }
  const raw = pipe(
    object({ ...columns, count: number() }),
    title('raw'),
    table({ name: 'raw', primaryKey: 'id' }),
  )

  const target = (): ReferenceTarget<typeof columns> => raw
  const ref = reference(pipe(string(), toNumber()), target, 'id')
  expectTypeOf<InferInput<typeof ref>>().toEqualTypeOf<string>()
  expectTypeOf<InferOutput<typeof ref>>().toEqualTypeOf<number>()

  // @ts-expect-error Generic raw-schema targets expose only declared columns.
  reference(pipe(string(), toNumber()), target, 'missing')

  // @ts-expect-error Additional table columns are not part of this reference contract.
  reference(number(), target, 'count')

  // @ts-expect-error Matching output does not replace the required string input.
  reference(number(), target, 'id')

  // @ts-expect-error The local output must match the declared numeric output.
  reference(string(), target, 'id')
})

it('rejects callback targets that do not satisfy their declared column schemas', () => {
  const Missing = defineTable('missing', { name: string() }, { primaryKey: 'name' })
  const Numeric = defineTable('numeric', { id: number() }, { primaryKey: 'id' })

  expectTypeOf(Missing).not.toMatchTypeOf<IdTarget>()
  expectTypeOf(Numeric).not.toMatchTypeOf<IdTarget>()

  // @ts-expect-error The callback must return a table exposing the declared id column.
  reference(string(), (): IdTarget => Missing, 'id')

  // @ts-expect-error The returned id schema must satisfy the declared string schema.
  reference(string(), (): IdTarget => Numeric, 'id')
})
