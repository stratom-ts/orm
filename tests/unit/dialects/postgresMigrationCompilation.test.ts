import { describe, expect, it } from 'vitest'

import { compilePostgresDdl } from '@/dialects/postgres/migration/sql'

/** Checks compiles constructive descriptive steps in the current test scenario. */
function assertCompilesConstructiveDescriptiveSteps() {
  expect(
    compilePostgresDdl({
      kind: 'create_index',
      schema: 'public',
      table: 'users',
      name: 'users_email_idx',
      columns: ['email'],
      unique: false,
    }).sql,
  ).toContain('create index "users_email_idx"')

  expect(
    compilePostgresDdl({
      kind: 'add_column',
      schema: 'public',
      table: 'users',
      column: {
        name: 'nickname',
        dataType: 'text',
        notNull: true,
        unique: false,
        autoIncrement: false,
      },
    }).sql,
  ).toContain('alter table "public"."users" add column "nickname" text not null')

  expect(
    compilePostgresDdl({
      kind: 'add_unique_constraint',
      schema: 'public',
      table: 'users',
      column: 'email',
      name: 'users_email_key',
    }).sql,
  ).toContain(
    'alter table "public"."users" add constraint "users_email_key" unique ("email")',
  )
}

const registerMigrationCompilationCases1 = () => {
  it('should compile constructive descriptive steps', () => {
    assertCompilesConstructiveDescriptiveSteps()

    const foreignKey = compilePostgresDdl({
      kind: 'add_foreign_key',
      schema: 'public',
      table: 'posts',
      column: 'authorId',
      references: {
        schema: 'public',
        table: 'users',
        column: 'id',
        onDelete: 'cascade',
        onUpdate: 'restrict',
      },
    }).sql

    expect(foreignKey).toContain('references "public"."users" ("id")')
    expect(foreignKey.toLowerCase()).toContain('on delete cascade on update restrict')
  })
}

const registerMigrationCompilationCases2 = () => {
  it('should compile destructive descriptive steps', () => {
    expect(
      compilePostgresDdl({
        kind: 'drop_column',
        schema: 'public',
        table: 'users',
        column: 'legacy',
      }).sql,
    ).toContain('alter table "public"."users" drop column "legacy"')

    expect(
      compilePostgresDdl({
        kind: 'drop_index',
        schema: 'public',
        table: 'users',
        index: 'users_legacy_idx',
      }).sql,
    ).toContain('drop index "public"."users_legacy_idx"')

    expect(
      compilePostgresDdl({
        kind: 'drop_table',
        schema: 'public',
        table: 'orphan',
      }).sql,
    ).toContain('drop table "public"."orphan"')
  })
}

function registerMigrationCompilationGroup1() {
  describe('PostgreSQL migration compilation', () => {
    registerMigrationCompilationCases1()
  })
}

function registerMigrationCompilationGroup2() {
  describe('PostgreSQL migration compilation', () => {
    registerMigrationCompilationCases2()
  })
}

describe('PostgreSQL migration compilation', () => {
  registerMigrationCompilationGroup1()
  registerMigrationCompilationGroup2()
})
