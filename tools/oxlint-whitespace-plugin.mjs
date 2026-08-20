const pluginName = 'stratom-style'

function getActualLastToken(sourceCode, node) {
  return sourceCode.getLastToken(node)
}

function isIifeStatement(node) {
  if (node.type !== 'ExpressionStatement') return false

  let expression = node.expression
  if (expression.type === 'ChainExpression') expression = expression.expression
  if (expression.type === 'UnaryExpression') expression = expression.argument
  if (expression.type === 'ChainExpression') expression = expression.expression

  return (
    expression.type === 'CallExpression' &&
    (expression.callee.type === 'ArrowFunctionExpression' ||
      expression.callee.type === 'FunctionExpression')
  )
}

function isBlockLikeStatement(sourceCode, node) {
  if (node.type === 'DoWhileStatement' && node.body.type === 'BlockStatement') return true
  if (isIifeStatement(node)) return true

  let lastToken = getActualLastToken(sourceCode, node)
  if (lastToken.value === ';') lastToken = sourceCode.getTokenBefore(lastToken)
  if (lastToken.value !== '}') return false

  const owner = sourceCode.getNodeByRangeIndex(lastToken.range[0])
  return owner?.type === 'BlockStatement' || owner?.type === 'SwitchStatement'
}

function getTrailingAnchor(sourceCode, node) {
  let anchor = getActualLastToken(sourceCode, node)

  for (const comment of sourceCode.getCommentsAfter(node)) {
    if (comment.loc.start.line !== anchor.loc.end.line) break
    anchor = comment
  }

  return anchor
}

function getAttachedLeadingComment(sourceCode, previousNode, node) {
  const comments = sourceCode
    .getCommentsBefore(node)
    .filter((comment) => comment.loc.start.line > previousNode.loc.end.line)

  let firstAttached = null
  let nextLine = node.loc.start.line

  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index]
    if (nextLine - comment.loc.end.line > 1) break

    firstAttached = comment
    nextLine = comment.loc.start.line
  }

  return firstAttached
}

function getIndent(source, offset) {
  const lineStart = Math.max(source.lastIndexOf('\n', offset - 1) + 1, 0)
  return /^[\t ]*/u.exec(source.slice(lineStart, offset))?.[0] ?? ''
}

function checkStatementList(context, statements) {
  const sourceCode = context.sourceCode
  const source = sourceCode.text
  const lineBreak = source.includes('\r\n') ? '\r\n' : '\n'

  for (let index = 1; index < statements.length; index += 1) {
    const previousNode = statements[index - 1]
    const node = statements[index]
    const leadingComment = getAttachedLeadingComment(sourceCode, previousNode, node)
    const previousIsMultilineBlock =
      previousNode.loc.start.line !== previousNode.loc.end.line &&
      isBlockLikeStatement(sourceCode, previousNode)
    const nodeIsBlock = isBlockLikeStatement(sourceCode, node)
    const nodeIsMultilineBlock = node.loc.start.line !== node.loc.end.line && nodeIsBlock
    const singleLineStatementHasComment =
      node.loc.start.line === node.loc.end.line && leadingComment !== null

    if (
      !previousIsMultilineBlock &&
      !nodeIsMultilineBlock &&
      !singleLineStatementHasComment
    ) {
      continue
    }

    const anchor = getTrailingAnchor(sourceCode, previousNode)
    const target = leadingComment ?? sourceCode.getFirstToken(node)
    const between = source.slice(anchor.range[1], target.range[0])

    // A detached comment between the statements is its own visual group. Leave it alone.
    if (!/^\s*$/u.test(between)) continue
    if (target.loc.start.line - anchor.loc.end.line === 2) continue

    context.report({
      node,
      messageId: 'expectedSingleBlankLine',
      fix(fixer) {
        const indent = getIndent(source, target.range[0])
        return fixer.replaceTextRange(
          [anchor.range[1], target.range[0]],
          `${lineBreak}${lineBreak}${indent}`,
        )
      },
    })
  }
}

const padMultilineBlocks = {
  meta: {
    type: 'layout',
    docs: {
      description: 'Require one blank line around multiline code blocks',
    },
    fixable: 'whitespace',
    schema: [],
    messages: {
      expectedSingleBlankLine: 'Expected exactly one blank line between code blocks.',
    },
  },
  create(context) {
    return {
      'Program:exit'(node) {
        checkStatementList(context, node.body)
      },
      'BlockStatement:exit'(node) {
        checkStatementList(context, node.body)
      },
      'StaticBlock:exit'(node) {
        checkStatementList(context, node.body)
      },
      'SwitchCase:exit'(node) {
        checkStatementList(context, node.consequent)
      },
      'TSModuleBlock:exit'(node) {
        checkStatementList(context, node.body)
      },
    }
  },
}

export default {
  meta: { name: pluginName },
  rules: { 'pad-multiline-blocks': padMultilineBlocks },
}
