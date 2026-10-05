import { describe, expect, it } from 'vitest'

import { compilePostgres } from '@/dialects/postgres/compile'

describe('PostgreSQL migration AST compilation', () => {
  it('compiles constructive descriptive steps', () => {
    assertCompilesConstructiveDescriptiveSteps()

    const foreignKey = compilePostgres({
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
})

describe('PostgreSQL migration AST compilation: compiles destructive descriptive steps', () => {
  it('compiles destructive descriptive steps', () => {
    expect(
      compilePostgres({
        kind: 'drop_column',
        schema: 'public',
        table: 'users',
        column: 'legacy',
      }).sql,
    ).toContain('alter table "public"."users" drop column "legacy"')

    expect(
      compilePostgres({
        kind: 'drop_index',
        schema: 'public',
        table: 'users',
        index: 'users_legacy_idx',
      }).sql,
    ).toContain('drop index "public"."users_legacy_idx"')

    expect(
      compilePostgres({
        kind: 'drop_table',
        schema: 'public',
        table: 'orphan',
      }).sql,
    ).toContain('drop table "public"."orphan"')
  })
})

/** Checks compiles constructive descriptive steps in the current test scenario. */
function assertCompilesConstructiveDescriptiveSteps() {
  expect(
    compilePostgres({
      kind: 'create_index',
      schema: 'public',
      table: 'users',
      name: 'users_email_idx',
      columns: ['email'],
      unique: false,
    }).sql,
  ).toContain('create index "users_email_idx"')

  expect(
    compilePostgres({
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
    compilePostgres({
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
