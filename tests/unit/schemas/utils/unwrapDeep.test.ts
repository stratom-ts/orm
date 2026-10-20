import {
  exactOptional,
  maxLength,
  nonNullable,
  nonNullish,
  nonOptional,
  nullable,
  nullish,
  optional,
  parse,
  pipe,
  string,
  undefinedable,
} from 'valibot'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { column, getColumnMetadata, unwrapDeep } from '@/index'

describe('unwrapDeep public contract', () => {
  it('should remove presence and nullability wrappers while preserving the inner pipe', () => {
    const inner = pipe(string(), maxLength(40), column({ unique: true }))
    const schema = nonNullish(
      nonNullable(
        nonOptional(nullish(nullable(undefinedable(exactOptional(optional(inner)))))),
      ),
    )

    const unwrapped = unwrapDeep(schema)

    expectTypeOf(unwrapped).toEqualTypeOf<typeof inner>()
    expect(unwrapped.pipe).toBe(inner.pipe)
    expect(parse(unwrapped, 'valid')).toBe('valid')
    expect(() => parse(unwrapped, 'x'.repeat(41))).toThrow(/Invalid length/)
    expect(getColumnMetadata(unwrapped)).toMatchObject({ kind: 'column', unique: true })
  })
})
