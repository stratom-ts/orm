import {
  exactOptional,
  maxLength,
  nonNullish,
  nullable,
  optional,
  pipe,
  string,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { column, unwrapDeep } from '@/index'

describe('unwrapDeep public contract', () => {
  it('removes presence and nullability wrappers while preserving the inner pipe', () => {
    const schema = nonNullish(
      nullable(
        exactOptional(optional(pipe(string(), maxLength(40), column({ unique: true })))),
      ),
    )

    const unwrapped = unwrapDeep(schema) as {
      type: string
      pipe?: readonly unknown[]
    }
    expect(unwrapped.type).toBe('string')
    expect(unwrapped.pipe?.[0]).toMatchObject({ type: 'string' })
    expect(
      unwrapped.pipe?.some(
        (action) => (action as { type?: string }).type === 'max_length',
      ),
    ).toBe(true)
    expect(
      unwrapped.pipe?.some((action) => (action as { type?: string }).type === 'metadata'),
    ).toBe(true)
  })
})
