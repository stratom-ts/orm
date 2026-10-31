import type { InferInput, InferOutput } from 'valibot'
import { number, object, pipe, string, title, toNumber } from 'valibot'
import { expectTypeOf, it } from 'vitest'

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
