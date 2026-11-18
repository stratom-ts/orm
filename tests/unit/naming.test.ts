import { describe, expect, it } from 'vitest'

import { snakeCase } from '../../src/naming'

describe('snakeCase', () => {
  it.each([
    ['id', 'id'],
    ['fullName', 'full_name'],
    ['FullName', 'full_name'],
    ['userID', 'user_id'],
    ['createdAtUTC', 'created_at_utc'],
    ['HTMLParser', 'html_parser'],
    ['address2', 'address_2'],
    ['homeAddress2', 'home_address_2'],
    ['v2Api', 'v_2_api'],
    ['md5hash', 'md_5_hash'],
    ['full_name', 'full_name'],
    ['full_Name', 'full_name'],
    ['address_2', 'address_2'],
    ['_internalId', '_internal_id'],
    ['caféOwner', 'café_owner'],
    ['ÉtatCivil2', 'État_civil_2'],
    ['userIDs', 'user_i_ds'],
  ])('should convert %s to %s and remain idempotent', (column, expected) => {
    const output = snakeCase({ column, table: 'example' })
    expect(output).toBe(expected)
    expect(snakeCase({ column: output, table: 'example' })).toBe(expected)
  })
})
