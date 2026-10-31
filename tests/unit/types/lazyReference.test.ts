import type { InferInput, InferOutput } from 'valibot'
import { number, object, pipe, string, title, toNumber } from 'valibot'
import { expectTypeOf, it } from 'vitest'

import type { TableHandle, TableSchema } from '@/index'
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

type IdSchema = Omit<TableSchema, 'entries'> & {
  entries: { id: ReturnType<typeof string> }
}

type IdTarget = Pick<TableHandle<IdSchema>, 'getSchema' | 'getTableMetadata'>

it('checks narrow target contracts across genuinely circular declarations', () => {
  const A = defineTable(
    'a',
    {
      id: string(),
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
      id: string(),
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
