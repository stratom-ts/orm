import {
  flatten,
  getDotPath,
  nullable,
  number,
  object,
  optional,
  pipe,
  string,
  transform,
  union,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { ValidationError, column, defineTable } from '@/index'
import { validateInsertRow, validateUpdatePatch } from '@/query/validate'

const Rows = defineTable(
  'validation_rows',
  {
    id: pipe(number(), column({ generation: { kind: 'identity', mode: 'always' } })),
    name: string(),
    count: number(),
    locked: pipe(string(), column({ readonly: true })),
    profile: optional(nullable(object({ alias: string() }))),
  },
  { primaryKey: 'id' },
)

function captureValidationError(operation: () => unknown): ValidationError {
  try {
    operation()
  } catch (error) {
    if (error instanceof ValidationError) return error
  }

  throw new Error('Expected validation to fail')
}

describe('insert validation issues', () => {
  it('should apply a default on an outer optional composite wrapper', () => {
    const Defaults = defineTable(
      'union_defaults',
      {
        id: string(),
        value: optional(union([string(), string()]), 'fallback'),
      },
      { primaryKey: 'id' },
    )

    expect(validateInsertRow(Defaults, { id: 'a' })).toEqual({
      id: 'a',
      value: 'fallback',
    })

    const InnerDefault = defineTable(
      'inner_union_default',
      {
        id: string(),
        value: union([optional(string(), 'inner'), string()]),
      },
      { primaryKey: 'id' },
    )

    expect(() => validateInsertRow(InnerDefault, { id: 'a' })).toThrow(ValidationError)
  })
})

describe('insert validation issues', () => {
  it.each([
    { row: null, message: 'expected a plain object row', path: null },
    { row: 'nope', message: 'expected a plain object row', path: null },
    { row: [], message: 'expected a plain object row', path: null },
  ])('should report root failures for $row', ({ row, message, path }) => {
    const error = captureValidationError(() => validateInsertRow(Rows, row))

    expect(error).toMatchObject({ table: 'validation_rows', operation: 'insert' })
    expect(error.issues).toHaveLength(1)
    expect(getDotPath(error.issues[0]!)).toBe(path)
    expect(flatten(error.issues).root?.[0]).toContain(message)
    expect(error.message).toContain(message)
  })

  it.each([
    {
      row: { name: 'A', count: 1, extra: true },
      key: 'extra',
      message: 'unknown or non-insertable',
    },
    {
      row: { id: 1, name: 'A', count: 1 },
      key: 'id',
      message: 'unknown or non-insertable',
    },
    { row: { name: undefined, count: 1 }, key: 'name', message: 'cannot be undefined' },
    { row: { name: 'A', count: '1' }, key: 'count', message: 'Invalid type' },
  ])('should report column failure at $key', ({ row, key, message }) => {
    const error = captureValidationError(() => validateInsertRow(Rows, row))

    expect(error.table).toBe('validation_rows')
    expect(error.operation).toBe('insert')
    expect(getDotPath(error.issues[0]!)).toBe(key)
    expect(flatten(error.issues).nested?.[key]?.[0]).toContain(message)
    expect(error.message).toContain(`${key}:`)
  })

  it('should retain Valibot required-field issues when a key is missing', () => {
    const error = captureValidationError(() => validateInsertRow(Rows, { name: 'A' }))

    expect(error.issues[0].type).toBe('object')
    expect(getDotPath(error.issues[0]!)).toBe('count')
    expect(error.message).toContain('count:')
  })
})

describe('insert issue aggregation', () => {
  it('should retain all issues for multiple invalid columns', () => {
    const error = captureValidationError(() =>
      validateInsertRow(Rows, { name: 1, count: '1', locked: 'L' }),
    )

    const paths = error.issues.map((issue) => getDotPath(issue))
    const flattened = flatten(error.issues).nested

    expect(paths).toEqual(['name', 'count'])
    expect(flattened?.name).toHaveLength(1)
    expect(flattened?.count).toHaveLength(1)
    expect(error.message).toContain(`name: ${flattened?.name?.[0]}`)
    expect(error.message).toContain(`count: ${flattened?.count?.[0]}`)
  })

  it('should preserve Valibot nested paths in flattened issues and messages', () => {
    const error = captureValidationError(() =>
      validateInsertRow(Rows, {
        name: 'A',
        count: 1,
        locked: 'L',
        profile: { alias: 2 },
      }),
    )

    expect(getDotPath(error.issues[0]!)).toBe('profile.alias')
    expect(flatten(error.issues).nested?.['profile.alias']).toHaveLength(1)
    expect(error.message).toContain('profile.alias:')
  })
})

describe('update validation issues', () => {
  it.each([
    { patch: null, message: 'expected a plain object patch', path: null },
    { patch: 'nope', message: 'expected a plain object patch', path: null },
    { patch: [], message: 'expected a plain object patch', path: null },
  ])('should report root failures for $patch', ({ patch, message, path }) => {
    const error = captureValidationError(() => validateUpdatePatch(Rows, patch))

    expect(error).toMatchObject({ table: 'validation_rows', operation: 'update' })
    expect(getDotPath(error.issues[0]!)).toBe(path)
    expect(flatten(error.issues).root?.[0]).toContain(message)
    expect(error.message).toContain(message)
  })

  it.each([
    { patch: { extra: 'x' }, key: 'extra', message: 'unknown or non-updatable' },
    { patch: { locked: 'x' }, key: 'locked', message: 'unknown or non-updatable' },
    { patch: { count: '1' }, key: 'count', message: 'Invalid type' },
  ])('should report column failure at $key', ({ patch, key, message }) => {
    const error = captureValidationError(() => validateUpdatePatch(Rows, patch))

    expect(error.table).toBe('validation_rows')
    expect(error.operation).toBe('update')
    expect(getDotPath(error.issues[0]!)).toBe(key)
    expect(flatten(error.issues).nested?.[key]?.[0]).toContain(message)
    expect(error.message).toContain(`${key}:`)
  })

  it.each([{}, { name: undefined }])(
    'should report an empty cleaned patch for %o',
    (patch) => {
      const error = captureValidationError(() => validateUpdatePatch(Rows, patch))

      expect(error.table).toBe('validation_rows')
      expect(error.operation).toBe('update')
      expect(getDotPath(error.issues[0]!)).toBeNull()

      expect(flatten(error.issues).root?.[0]).toContain(
        'patch must include at least one column',
      )

      expect(error.message).toContain('patch must include at least one column')
    },
  )

  it('should allow undefined update values when another column remains', () => {
    expect(validateUpdatePatch(Rows, { name: undefined, count: 1 })).toEqual({ count: 1 })
  })
})

describe('nullable transformed outputs', () => {
  const Transformed = defineTable(
    'validation_nullable_outputs',
    {
      id: string(),
      label: string(),
      value: pipe(
        string(),
        transform((value): number | null => (value === 'null' ? null : Number(value))),
        nullable(number()),
      ),
    },
    { primaryKey: 'id' },
  )

  it('should reject direct null insert input at the value column', () => {
    const error = captureValidationError(() =>
      validateInsertRow(Transformed, { id: 'a', label: 'A', value: null }),
    )

    expect(error.operation).toBe('insert')
    expect(getDotPath(error.issues[0]!)).toBe('value')
  })

  it('should reject direct null update input at the value column', () => {
    const error = captureValidationError(() =>
      validateUpdatePatch(Transformed, { value: null }),
    )

    expect(error.operation).toBe('update')
    expect(getDotPath(error.issues[0]!)).toBe('value')
  })

  it.each([
    { input: 'null', output: null },
    { input: '7.5', output: 7.5 },
  ])('should transform $input for inserts and updates', ({ input, output }) => {
    expect(validateInsertRow(Transformed, { id: 'a', label: 'A', value: input })).toEqual(
      {
        id: 'a',
        label: 'A',
        value: output,
      },
    )

    expect(validateUpdatePatch(Transformed, { value: input })).toEqual({ value: output })
  })

  it('should require the value on insert and allow omission on update', () => {
    const error = captureValidationError(() =>
      validateInsertRow(Transformed, { id: 'a', label: 'A' }),
    )

    expect(error.operation).toBe('insert')
    expect(getDotPath(error.issues[0]!)).toBe('value')
    expect(validateUpdatePatch(Transformed, { label: 'B' })).toEqual({ label: 'B' })
  })
})
