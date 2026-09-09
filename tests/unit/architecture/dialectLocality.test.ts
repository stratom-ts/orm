import ts from '@typescript/typescript6'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const CORE_PATHS = [
  'src/client.ts',
  'src/defineTable.ts',
  'src/ddl',
  'src/migrations',
  'src/operations',
  'src/query',
  'src/schemas',
]
const SHARED_EXECUTION_PATHS = [
  'src/query',
  'src/ddl',
  'src/migrations',
  'src/operations',
]

function sourceFiles(path: string): string[] {
  const absolute = join(ROOT, path)
  if (absolute.endsWith('.ts')) return [absolute]

  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(absolute, entry.name)
    return entry.isDirectory()
      ? sourceFiles(relative(ROOT, child))
      : entry.name.endsWith('.ts')
        ? [child]
        : []
  })
}

const coreFiles = CORE_PATHS.flatMap(sourceFiles)
const sharedExecutionFiles = SHARED_EXECUTION_PATHS.flatMap(sourceFiles)
const DIALECT_BARREL_RUNTIME_ALLOWLIST = new Set(['resolveDialect'])

function parseSource(text: string, file = 'architecture-fixture.ts'): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function parse(file: string): ts.SourceFile {
  return parseSource(readFileSync(file, 'utf8'), file)
}

function location(source: ts.SourceFile, node: ts.Node): string {
  const point = source.getLineAndCharacterOfPosition(node.getStart(source))
  return `${relative(ROOT, source.fileName)}:${point.line + 1}`
}

function descendants(source: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = []

  const visit = (node: ts.Node) => {
    nodes.push(node)
    node.forEachChild(visit)
  }

  visit(source)
  return nodes
}

function moduleSpecifier(node: ts.Node): ts.StringLiteral | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      ? node.moduleSpecifier
      : undefined
  }

  return undefined
}

function isConcreteDialectImport(specifier: string): boolean {
  const normalized = specifier.replaceAll('\\', '/')
  const marker = '/dialects/'
  const offset = normalized.indexOf(marker)

  if (offset === -1) return false

  const module = normalized.slice(offset + marker.length)
  return !['catalog', 'resolve', 'types'].includes(module)
}

function isDialectBarrel(specifier: string): boolean {
  return specifier.replaceAll('\\', '/').endsWith('/dialects')
}

function isDb0ModuleSpecifier(specifier: string): boolean {
  const normalized = specifier.replaceAll('\\', '/')
  return normalized === 'db0' || normalized.startsWith('db0/')
}

function nonAllowlistedBarrelRuntimeMember(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause
    if (!clause) return '*'
    if (clause.isTypeOnly) return undefined
    if (clause.name) return clause.name.text

    const bindings = clause.namedBindings
    if (!bindings) return undefined
    if (ts.isNamespaceImport(bindings)) return bindings.name.text

    return bindings.elements.find(
      (element) =>
        !element.isTypeOnly &&
        !DIALECT_BARREL_RUNTIME_ALLOWLIST.has(
          (element.propertyName ?? element.name).text,
        ),
    )?.name.text
  }

  if (!ts.isExportDeclaration(node) || node.isTypeOnly) return undefined

  const exports = node.exportClause
  if (!exports) return '*'
  if (ts.isNamespaceExport(exports)) return exports.name.text

  return exports.elements.find(
    (element) =>
      !element.isTypeOnly &&
      !DIALECT_BARREL_RUNTIME_ALLOWLIST.has((element.propertyName ?? element.name).text),
  )?.name.text
}

function concreteDialectReference(node: ts.Node): string | undefined {
  const specifier = moduleSpecifier(node)

  if (specifier) {
    if (isConcreteDialectImport(specifier.text)) return specifier.text
    if (isDialectBarrel(specifier.text)) return nonAllowlistedBarrelRuntimeMember(node)
  }

  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0]) &&
    (isConcreteDialectImport(node.arguments[0].text) ||
      isDialectBarrel(node.arguments[0].text))
  ) {
    return node.arguments[0].text
  }

  return undefined
}

function rootIdentifier(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isParenthesizedExpression(node)) return rootIdentifier(node.expression)

  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node)
  ) {
    return rootIdentifier(node.expression)
  }

  return undefined
}

function db0ExecutionReference(node: ts.Node): string | undefined {
  const specifier = moduleSpecifier(node)

  if (specifier && isDb0ModuleSpecifier(specifier.text)) return specifier.text

  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0]) &&
    isDb0ModuleSpecifier(node.arguments[0].text)
  ) {
    return node.arguments[0].text
  }

  const access = ts.isPropertyAccessExpression(node)
    ? node
    : ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      ? node.expression
      : undefined

  if (!access) return undefined

  const method = access.name.text
  if (!['prepare', 'bind', 'all'].includes(method)) return undefined

  const root = rootIdentifier(access.expression)

  if (root && /database|statement|prepared/i.test(root)) {
    return `${root}.${method}`
  }

  return undefined
}

function propertyName(node: ts.PropertyName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined
}

function declaredPropertyNames(source: ts.SourceFile, declarationName: string): string[] {
  const declaration = descendants(source).find(
    (node) =>
      (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
      node.name.text === declarationName,
  )

  if (!declaration) return []

  return descendants(declaration)
    .flatMap((node) =>
      ts.isPropertySignature(node) && node.name ? [propertyName(node.name)] : [],
    )
    .filter((name): name is string => name !== undefined)
}

function containsConnectorDialect(node: ts.Node): boolean {
  let found = false

  const visit = (candidate: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(candidate) &&
      candidate.name.text === 'dialect' &&
      (candidate.expression.getText().endsWith('.connector') ||
        candidate.expression.getText() === 'connector')
    ) {
      found = true
    }

    candidate.forEachChild(visit)
  }

  visit(node)
  return found
}

function containsDialectPolicySelector(node: ts.Node): boolean {
  let found = containsConnectorDialect(node)

  const visit = (candidate: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(candidate) &&
      candidate.name.text === 'id' &&
      candidate.expression.getText().endsWith('dialect')
    ) {
      found = true
    }

    candidate.forEachChild(visit)
  }

  visit(node)
  return found
}

function physicalSqlText(node: ts.StringLiteralLike | ts.TemplateExpression): string {
  if (!ts.isTemplateExpression(node)) return node.text

  return [
    node.head.text,
    ...node.templateSpans.flatMap((span) => ['${value}', span.literal.text]),
  ].join('')
}

function looksLikePhysicalSql(value: string): boolean {
  return /^(?:select\s+(?:\d+|.+\s+from\s+)|insert\s+into\s+.+\s+(?:values|select)\s*|update\s+.+\s+set\s+|create\s+(?:table|schema|index)\s+|alter\s+table\s+|drop\s+(?:table|index)\s+|begin\s*$|commit\s*$|rollback(?:\s+to\s+savepoint\s+.+)?\s*$|savepoint\s+|release\s+savepoint\s+)/i.test(
    value.trim(),
  )
}

function containsProperty(node: ts.Node, property: string): boolean {
  return descendants(node).some(
    (candidate) =>
      ts.isPropertyAccessExpression(candidate) && candidate.name.text === property,
  )
}

function memberCollectionName(node: ts.Expression): string | undefined {
  if (!ts.isIdentifier(node)) return undefined

  return /(?:column|index)(?:names?)?$/i.test(node.text) ||
    /(?:columns|indexes|columnnames|indexnames)/i.test(node.text)
    ? node.text
    : undefined
}

function isCanonicalMemberArray(node: ts.Expression): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'memberKeys'
  ) {
    return true
  }

  return containsProperty(node, 'comparisonKey')
}

function rawArrayComparisonLeak(
  source: ts.SourceFile,
  node: ts.Node,
): string | undefined {
  if (
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== 'arraysEqual' ||
    !node.arguments.some((argument) => !isCanonicalMemberArray(argument))
  ) {
    return undefined
  }

  return `${location(source, node)} compares raw member arrays`
}

function rawCollectionKeyLeak(source: ts.SourceFile, node: ts.Node): string | undefined {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !['get', 'has', 'set', 'add'].includes(node.expression.name.text) ||
    !memberCollectionName(node.expression.expression) ||
    !node.arguments[0] ||
    !containsProperty(node.arguments[0], 'name') ||
    containsProperty(node.arguments[0], 'comparisonKey')
  ) {
    return undefined
  }

  return `${location(source, node)} keys a member collection by raw name`
}

function rawCollectionConstructionLeak(
  source: ts.SourceFile,
  node: ts.Node,
): string | undefined {
  if (
    !ts.isNewExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    (node.expression.text !== 'Map' && node.expression.text !== 'Set') ||
    !ts.isVariableDeclaration(node.parent) ||
    !ts.isIdentifier(node.parent.name) ||
    !memberCollectionName(node.parent.name) ||
    !node.arguments?.some(
      (argument) =>
        containsProperty(argument, 'name') &&
        !containsProperty(argument, 'comparisonKey'),
    )
  ) {
    return undefined
  }

  return `${location(source, node)} constructs a member collection from raw names`
}

function rawOrderingLeak(source: ts.SourceFile, node: ts.Node): string | undefined {
  if (
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== 'compareCodeUnits' ||
    node.arguments.length !== 2 ||
    !node.arguments.every(
      (argument) =>
        ts.isPropertyAccessExpression(argument) && argument.name.text === 'name',
    )
  ) {
    return undefined
  }

  return `${location(source, node)} orders members by raw names`
}

/** Finds generic Migration expressions that use member spellings as semantic keys. */
function rawMemberComparisonLeaks(source: ts.SourceFile): string[] {
  return descendants(source).flatMap((node) => {
    const leak =
      rawArrayComparisonLeak(source, node) ??
      rawCollectionKeyLeak(source, node) ??
      rawCollectionConstructionLeak(source, node) ??
      rawOrderingLeak(source, node)
    return leak === undefined ? [] : [leak]
  })
}

describe('dialect extension locality architecture', () => {
  it('keeps concrete dialect imports outside Client, Schema, Query, Migration, and Operations', () => {
    const violations = coreFiles.flatMap((file) => {
      const source = parse(file)
      return descendants(source).flatMap((node) => {
        const reference = concreteDialectReference(node)
        return reference
          ? [`${location(source, node)} imports concrete dialect ${reference}`]
          : []
      })
    })

    expect(violations).toEqual([])
  })

  it.each([
    ["import type { Dialect } from '@/dialects'", false],
    ["import type DefaultDialect from '@/dialects'", false],
    ["import { resolveDialect } from '@/dialects'", false],
    ["import { resolveDialect as resolve } from '@/dialects'", false],
    ["export { resolveDialect } from '@/dialects'", false],
    ["export { resolveDialect as resolve } from '@/dialects'", false],
    ["export type { Dialect } from '@/dialects'", false],
    ["import { postgresDialect } from '@/dialects'", true],
    ["import { oracleDialect } from '@/dialects'", true],
    ["import { postgresDialect as selected } from '@/dialects'", true],
    ["import { createDb0PostgresqlOperationSessionProvider } from '@/dialects'", true],
    ["export { sqliteDialect } from '@/dialects'", true],
    ["export { mssqlDialect } from '@/dialects'", true],
    ["import { resolveDialect, oracleDialect } from '@/dialects'", true],
    ["export { resolveDialect, mssqlDialect } from '@/dialects'", true],
    ["import defaultDialect from '@/dialects'", true],
    ["import * as dialects from '@/dialects'", true],
    ["import '@/dialects'", true],
    ["export * from '@/dialects'", true],
    ["export * as dialects from '@/dialects'", true],
    ["import { member } from '@/dialects/postgres'", true],
    ["const member = import('@/dialects/postgres')", true],
    ["const members = import('@/dialects')", true],
  ])('classifies concrete dialect reference %s', (code, rejected) => {
    const source = parseSource(code)
    const references = descendants(source).flatMap((node) =>
      concreteDialectReference(node) ? [node] : [],
    )

    expect(references.length > 0).toBe(rejected)
  })

  it('keeps db0 transport adaptation out of shared Query, Migration, and Operations', () => {
    const violations = sharedExecutionFiles.flatMap((file) => {
      const source = parse(file)
      return descendants(source).flatMap((node) => {
        const reference = db0ExecutionReference(node)
        return reference ? [`${location(source, node)} references ${reference}`] : []
      })
    })

    expect(violations).toEqual([])
  })

  it.each([
    ['import type { Database } from "db0"', true],
    ['import type { Database } from "db0/connectors/postgresql"', true],
    ["export type { Database } from 'db0'", true],
    ["export type { Database } from 'db0/connectors/postgresql'", true],
    ["import { Database } from 'db0'", true],
    ["import { Database } from 'db0/connectors/postgresql'", true],
    ["export { Database } from 'db0'", true],
    ["export { Database } from 'db0/connectors/postgresql'", true],
    ["const db0 = import('db0')", true],
    ["const db0 = import('db0/connectors/postgresql')", true],
    ['database.prepare("select 1").bind(1).all()', true],
    ['database.prepare("select 1")', true],
    ['statement.bind(1)', true],
    ['statement.all()', true],
    ['executor.run(query)', false],
    ['session.run(query)', false],
    ['executor.execute(query)', false],
  ])('classifies shared execution reference %s', (code, rejected) => {
    const source = parseSource(code)
    const references = descendants(source).flatMap((node) =>
      db0ExecutionReference(node) ? [node] : [],
    )

    expect(references.length > 0).toBe(rejected)
  })

  it('keeps physical SQL construction inside dialect members', () => {
    const violations = coreFiles.flatMap((file) => {
      const source = parse(file)
      return descendants(source).flatMap((node) => {
        const semanticKind =
          ts.isStringLiteralLike(node) &&
          ts.isPropertyAssignment(node.parent) &&
          propertyName(node.parent.name) === 'kind'
        const literalSql =
          !semanticKind &&
          (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
          looksLikePhysicalSql(physicalSqlText(node))
        const sqlProperty =
          ts.isPropertyAssignment(node) &&
          propertyName(node.name) === 'sql' &&
          (ts.isStringLiteralLike(node.initializer) ||
            ts.isTemplateExpression(node.initializer) ||
            ts.isNoSubstitutionTemplateLiteral(node.initializer))

        if (literalSql || sqlProperty) {
          return [location(source, node)]
        }

        return []
      })
    })

    expect(violations).toEqual([])
  })

  it('keeps engine identifiers and namespace defaults out of executable core code', () => {
    const engineTerms = new Set(['postgresql', 'postgres', 'sqlite', 'mysql', 'public'])
    const violations = coreFiles.flatMap((file) => {
      const source = parse(file)
      return descendants(source).flatMap((node) => {
        const engineIdentifier =
          ts.isStringLiteralLike(node) && engineTerms.has(node.text.toLowerCase())
        const namespaceDefault =
          ts.isPropertyAssignment(node) &&
          ['registrationDefault', 'writableDefault'].includes(
            propertyName(node.name) ?? '',
          ) &&
          ts.isArrayLiteralExpression(node.initializer)

        return engineIdentifier || namespaceDefault
          ? [`${location(source, node)} contains engine-specific namespace policy`]
          : []
      })
    })

    expect(violations).toEqual([])
  })

  it('keeps authored Schema metadata contracted to structured relation addressing', () => {
    const sharedTypes = parse(join(ROOT, 'src/schemas/actions/types.ts'))
    const tableAction = parse(join(ROOT, 'src/schemas/actions/table.ts'))
    const referenceAction = parse(join(ROOT, 'src/schemas/actions/reference.ts'))

    expect(declaredPropertyNames(sharedTypes, 'TableMetadata')).not.toContain('schema')
    expect(declaredPropertyNames(sharedTypes, 'TableOptions')).not.toContain('schema')
    expect(declaredPropertyNames(tableAction, 'TableActionConfig')).not.toContain(
      'schema',
    )
    expect(declaredPropertyNames(sharedTypes, 'ReferenceMetadata')).not.toContain('table')
    expect(declaredPropertyNames(sharedTypes, 'ReferenceMetadata')).not.toContain('key')

    expect(readFileSync(tableAction.fileName, 'utf8')).not.toMatch(
      /\b(?:config|metadata)\.schema\b/,
    )
    expect(readFileSync(referenceAction.fileName, 'utf8')).not.toMatch(
      /\b(?:metadata|reference)\.(?:table|key)\b/,
    )
  })

  it('keeps physical DDL addressing out of generic Migration and Dialect interfaces', () => {
    const migrationFiles = sourceFiles('src/ddl')
    const roleViolations = migrationFiles.flatMap((file) => {
      const source = parse(file)
      return descendants(source).flatMap((node) => {
        if (
          ts.isPropertyAssignment(node) &&
          propertyName(node.name) === 'role' &&
          ts.isStringLiteralLike(node.initializer) &&
          node.initializer.text === 'schema'
        ) {
          return [location(source, node)]
        }

        return []
      })
    })
    const sharedTypes = parse(join(ROOT, 'src/dialects/types.ts'))
    const physicalDdlTypes = descendants(sharedTypes).flatMap((node) => {
      if (
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        /^(?:CreateTable|CreateSchema|CreateIndex|AlterTable|AddForeignKey|AddUniqueConstraint|AlterColumn|SetNotNull|Drop)/.test(
          node.name.text,
        )
      ) {
        return [`${location(sharedTypes, node)} declares ${node.name.text}`]
      }

      return []
    })
    const migrationText = migrationFiles
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')

    expect(roleViolations).toEqual([])
    expect(physicalDdlTypes).toEqual([])
    expect(migrationText).not.toContain('physicalRelationInput')
  })

  it('uses canonical comparison keys for generic Migration member reconciliation', () => {
    const source = parse(join(ROOT, 'src/ddl/migrationPlan.ts'))
    expect(rawMemberComparisonLeaks(source)).toEqual([])
  })

  it.each([
    [
      'canonical arrays',
      "arraysEqual(memberKeys('column', current.columns, identities), desired.primaryKey.map((column) => column.comparisonKey))",
      false,
    ],
    ['raw arrays', 'arraysEqual(current.columns, desired.primaryKey)', true],
    ['canonical map key', 'liveColumns.get(desired.identifier.comparisonKey)', false],
    ['raw map key', 'liveColumns.get(desired.name)', true],
    [
      'canonical set construction',
      'const desiredColumnNames = new Set(createAst.columns.map((column) => column.identifier.comparisonKey))',
      false,
    ],
    [
      'raw set construction',
      'const desiredColumnNames = new Set(createAst.columns.map((column) => column.name))',
      true,
    ],
    [
      'canonical member order',
      'compareCodeUnits(left.name.comparisonKey, right.name.comparisonKey)',
      false,
    ],
    ['raw member order', 'compareCodeUnits(left.name, right.name)', true],
  ] as const)('classifies %s comparison', (_label, code, rejected) => {
    expect(rawMemberComparisonLeaks(parseSource(code)).length > 0).toBe(rejected)
  })

  it('allows connector dialect only as the resolver input and forbids policy branches', () => {
    const selections: string[] = []
    const branches: string[] = []

    for (const file of coreFiles) {
      const source = parse(file)

      for (const node of descendants(source)) {
        if (
          ts.isPropertyAccessExpression(node) &&
          node.name.text === 'dialect' &&
          node.expression.getText() === 'config.connector'
        ) {
          const parent = node.parent
          const selected =
            ts.isCallExpression(parent) &&
            ts.isIdentifier(parent.expression) &&
            parent.expression.text === 'resolveDialect'
          selections.push(`${location(source, node)}:${selected ? 'resolver' : 'other'}`)
        }

        if (
          (ts.isIfStatement(node) ||
            ts.isSwitchStatement(node) ||
            ts.isConditionalExpression(node)) &&
          containsDialectPolicySelector(
            ts.isIfStatement(node)
              ? node.expression
              : ts.isSwitchStatement(node)
                ? node.expression
                : node.condition,
          )
        ) {
          branches.push(location(source, node))
        }
      }
    }

    expect(selections).toHaveLength(1)
    expect(selections[0]).toMatch(/src[/\\]client\.ts:\d+:resolver$/)
    expect(branches).toEqual([])
  })
})
