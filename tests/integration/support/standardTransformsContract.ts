import {
  bigint,
  check,
  maxLength,
  maxValue,
  minValue,
  normalize,
  number,
  pipe,
  string,
  toBigint,
  toLowerCase,
  toMaxValue,
  toMinValue,
  toUpperCase,
  trimEnd,
  trimStart,
} from 'valibot'
import { expect } from 'vitest'

import type { Db } from '@/index'
import { defineTable } from '@/index'
import type { InferInsert } from '@/types/views'
import { ValidationError } from '@/utils/error'

let checkedInputCount = 0
const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

const StandardTransforms = defineTable(
  'standard_transforms',
  {
    id: string(),
    startsTrimmed: pipe(string(), trimStart()),
    endsTrimmed: pipe(string(), trimEnd()),
    lower: pipe(string(), toLowerCase()),
    upper: pipe(string(), maxLength(1), toUpperCase()),
    nfc: pipe(string(), normalize('NFC')),
    nfd: pipe(string(), normalize('NFD')),
    nfkc: pipe(string(), normalize('NFKC')),
    nfkd: pipe(string(), normalize('NFKD')),
    boundedNumber: pipe(number(), toMinValue(0), toMaxValue(100)),
    boundedBigint: pipe(bigint(), toMinValue(-5n), toMaxValue(5n)),
    parsedBigint: pipe(string(), toBigint()),
    boundedStorageBigint: pipe(
      string(),
      toBigint(),
      minValue(INT64_MIN),
      maxValue(INT64_MAX),
    ),
    checkedUpper: pipe(
      string(),
      check(() => {
        checkedInputCount += 1
        return true
      }),
      toUpperCase(),
    ),
    shortUpper: pipe(string(), toUpperCase(), maxLength(1)),
  },
  { primaryKey: 'id' },
)

/** Exercises known transforms through write validation and output-aware CRUD mapping. */
async function assertStandardTransformCrud(
  db: Db<readonly [typeof StandardTransforms]>,
  dialect: 'postgres' | 'sqlite',
) {
  await db.migrate().execute()

  const input = {
    id: 'first',
    startsTrimmed: '  left',
    endsTrimmed: 'right  ',
    lower: 'MiXeD',
    upper: 'ß',
    nfc: 'e\u0301',
    nfd: 'é',
    nfkc: '①',
    nfkd: '①',
    boundedNumber: 150,
    boundedBigint: 99n,
    parsedBigint: '9007199254740993',
    boundedStorageBigint: '0',
    checkedUpper: 'once',
    shortUpper: 'a',
  }

  const expected = {
    ...input,
    startsTrimmed: 'left',
    endsTrimmed: 'right',
    lower: 'mixed',
    upper: 'SS',
    nfc: 'é',
    nfd: 'e\u0301',
    nfkc: '1',
    nfkd: '1',
    boundedNumber: 100,
    boundedBigint: 5n,
    parsedBigint: 9007199254740993n,
    boundedStorageBigint: 0n,
    checkedUpper: 'ONCE',
    shortUpper: 'A',
  }

  await assertInsertReadAndUpdate(db, input, expected)

  await assertRejectedWrites(db, input)
  await assertBigintLimits(db, input)
  await assertDialectBigint(db, input, dialect)
}

async function assertInsertReadAndUpdate(
  db: Db<readonly [typeof StandardTransforms]>,
  input: InferInsert<typeof StandardTransforms>,
  expected: Record<string, unknown>,
) {
  checkedInputCount = 0
  expect(await db.insert(StandardTransforms).values(input).execute()).toEqual([expected])
  expect(checkedInputCount).toBe(1)

  expect(await db.from(StandardTransforms).where({ id: 'first' }).execute()).toEqual([
    expected,
  ])

  expect(checkedInputCount).toBe(1)

  const updated = { ...input, id: 'first', boundedNumber: -1, boundedBigint: -99n }
  expect(
    await db.update(StandardTransforms).set(updated).where({ id: 'first' }).execute(),
  ).toEqual([{ ...expected, boundedNumber: 0, boundedBigint: -5n }])

  expect(checkedInputCount).toBe(2)
  await db.from(StandardTransforms).where({ id: 'first' }).execute()
  expect(checkedInputCount).toBe(2)
}

async function assertDialectBigint(
  db: Db<readonly [typeof StandardTransforms]>,
  input: InferInsert<typeof StandardTransforms>,
  dialect: 'postgres' | 'sqlite',
) {
  if (dialect === 'postgres') {
    await db
      .insert(StandardTransforms)
      .values({ ...input, id: 'postgres-wide', parsedBigint: '9223372036854775808' })
      .execute()

    expect(
      (await db.from(StandardTransforms).where({ id: 'postgres-wide' }).execute())[0]
        ?.parsedBigint,
    ).toBe(9223372036854775808n)
  } else {
    await expect(async () =>
      db
        .insert(StandardTransforms)
        .values({ ...input, id: 'sqlite-wide', parsedBigint: '9223372036854775808' })
        .execute(),
    ).rejects.toThrow(/signed 64-bit integer range/)
  }
}

async function assertRejectedWrites(
  db: Db<readonly [typeof StandardTransforms]>,
  input: InferInsert<typeof StandardTransforms>,
) {
  await expect(async () =>
    db
      .insert(StandardTransforms)
      .values({ ...input, id: 'invalid-insert', shortUpper: 'ß' })
      .execute(),
  ).rejects.toThrow(ValidationError)

  await expect(async () =>
    db
      .update(StandardTransforms)
      .set({ shortUpper: 'ß' })
      .where({ id: 'first' })
      .execute(),
  ).rejects.toThrow(ValidationError)

  expect(
    await db.from(StandardTransforms).where({ id: 'invalid-insert' }).execute(),
  ).toEqual([])

  expect(
    (await db.from(StandardTransforms).where({ id: 'first' }).execute())[0]?.shortUpper,
  ).toBe('A')
}

async function assertBigintLimits(
  db: Db<readonly [typeof StandardTransforms]>,
  input: InferInsert<typeof StandardTransforms>,
) {
  await db
    .insert(StandardTransforms)
    .values({ ...input, id: 'int64-min', boundedStorageBigint: INT64_MIN.toString() })
    .execute()

  await db
    .insert(StandardTransforms)
    .values({ ...input, id: 'int64-max', boundedStorageBigint: INT64_MAX.toString() })
    .execute()

  expect(
    (await db.from(StandardTransforms).where({ id: 'int64-min' }).execute())[0]
      ?.boundedStorageBigint,
  ).toBe(INT64_MIN)

  expect(
    (await db.from(StandardTransforms).where({ id: 'int64-max' }).execute())[0]
      ?.boundedStorageBigint,
  ).toBe(INT64_MAX)

  await expect(async () =>
    db
      .insert(StandardTransforms)
      .values({
        ...input,
        id: 'outside-int64',
        boundedStorageBigint: (INT64_MAX + 1n).toString(),
      })
      .execute(),
  ).rejects.toThrow(ValidationError)
}

export { StandardTransforms, assertStandardTransformCrud }
