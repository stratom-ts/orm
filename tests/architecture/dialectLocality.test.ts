import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
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

function descendants(source: ts.SourceFile): ts.Node[] {
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

function isEngineMemberName(name: string): boolean {
  return /(?:postgres(?:ql)?|sqlite|mysql|libsql)/i.test(name)
}

function concreteBarrelMember(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause
    if (!clause || clause.isTypeOnly) return undefined
    if (clause.name) return clause.name.text
    const bindings = clause.namedBindings
    if (!bindings) return undefined
    if (ts.isNamespaceImport(bindings)) return bindings.name.text

    return bindings.elements.find(
      (element) =>
        !element.isTypeOnly &&
        isEngineMemberName((element.propertyName ?? element.name).text),
    )?.name.text
  }

  if (!ts.isExportDeclaration(node) || node.isTypeOnly) return undefined
  const exports = node.exportClause
  if (!exports || ts.isNamespaceExport(exports)) return '*'
  return exports.elements.find((element) =>
    isEngineMemberName((element.propertyName ?? element.name).text),
  )?.name.text
}

function concreteDialectReference(node: ts.Node): string | undefined {
  const specifier = moduleSpecifier(node)

  if (specifier) {
    if (isConcreteDialectImport(specifier.text)) return specifier.text
    if (isDialectBarrel(specifier.text)) return concreteBarrelMember(node)
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

function propertyName(node: ts.PropertyName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined
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
    ["import { resolveDialect } from '@/dialects'", false],
    ["import { postgresDialect } from '@/dialects'", true],
    ["import { postgresDialect as selected } from '@/dialects'", true],
    ["import { createDb0PostgresqlOperationSessionProvider } from '@/dialects'", true],
    ["export { sqliteDialect } from '@/dialects'", true],
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
