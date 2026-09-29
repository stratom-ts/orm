function getActualLastToken(sourceCode, node) {
  return sourceCode.getLastToken(node)
}

function isIifeStatement(node) {
  if (node.type !== 'ExpressionStatement') {
    return false
  }

  let { expression } = node

  if (expression.type === 'ChainExpression') {
    expression = expression.expression
  }

  if (expression.type === 'UnaryExpression') {
    expression = expression.argument
  }

  if (expression.type === 'ChainExpression') {
    expression = expression.expression
  }

  return (
    expression.type === 'CallExpression' &&
    (expression.callee.type === 'ArrowFunctionExpression' ||
      expression.callee.type === 'FunctionExpression')
  )
}

function isBlockLikeStatement(sourceCode, node) {
  if (node.type === 'DoWhileStatement' && node.body.type === 'BlockStatement') {
    return true
  }

  if (isIifeStatement(node)) {
    return true
  }

  let lastToken = getActualLastToken(sourceCode, node)

  if (lastToken.value === ';') {
    lastToken = sourceCode.getTokenBefore(lastToken)
  }

  if (lastToken.value !== '}') {
    return false
  }

  const owner = sourceCode.getNodeByRangeIndex(lastToken.range[0])
  return owner?.type === 'BlockStatement' || owner?.type === 'SwitchStatement'
}

function isCallExpression(expression) {
  if (expression.type === 'CallExpression') {
    return true
  }

  if (expression.type === 'AwaitExpression') {
    return isCallExpression(expression.argument)
  }

  if (expression.type === 'ChainExpression') {
    return isCallExpression(expression.expression)
  }

  return false
}

function isMultilineCallStatement(node) {
  return (
    node.type === 'ExpressionStatement' &&
    node.loc.start.line !== node.loc.end.line &&
    isCallExpression(node.expression)
  )
}

function callChainDepth(expression) {
  if (expression.type === 'ChainExpression') {
    return callChainDepth(expression.expression)
  }

  if (expression.type === 'CallExpression') {
    return 1 + callChainDepth(expression.callee)
  }

  if (expression.type === 'MemberExpression') {
    return callChainDepth(expression.object)
  }

  return 0
}

function isMultilineCallChainDeclaration(node) {
  return (
    node.type === 'VariableDeclaration' &&
    node.loc.start.line !== node.loc.end.line &&
    node.declarations.some(
      (declaration) => declaration.init !== null && callChainDepth(declaration.init) > 1,
    )
  )
}

function isMultilineTypeDeclaration(node) {
  const declaration =
    node.type === 'ExportNamedDeclaration' && node.declaration !== null
      ? node.declaration
      : node

  return (
    (declaration.type === 'TSTypeAliasDeclaration' ||
      declaration.type === 'TSInterfaceDeclaration') &&
    declaration.loc.start.line !== declaration.loc.end.line
  )
}

function isMultilineBlockStatement(sourceCode, node) {
  return (
    node.loc.start.line !== node.loc.end.line && isBlockLikeStatement(sourceCode, node)
  )
}

function isPaddedMultilineStatement(sourceCode, node) {
  return (
    isMultilineBlockStatement(sourceCode, node) ||
    isMultilineCallStatement(node) ||
    isMultilineCallChainDeclaration(node) ||
    isMultilineTypeDeclaration(node)
  )
}

function isSingleLineIfStatement(node) {
  return node.type === 'IfStatement' && node.loc.start.line === node.loc.end.line
}

function addBindingNames(pattern, names) {
  if (pattern.type === 'Identifier') {
    names.add(pattern.name)
    return
  }

  if (pattern.type === 'RestElement') {
    addBindingNames(pattern.argument, names)
    return
  }

  if (pattern.type === 'AssignmentPattern') {
    addBindingNames(pattern.left, names)
    return
  }

  if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements.filter((element) => element !== null)) {
      addBindingNames(element, names)
    }

    return
  }

  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      addBindingNames(
        property.type === 'RestElement' ? property.argument : property.value,
        names,
      )
    }
  }
}

function containsBindingReference(value, names) {
  if (value === null || typeof value !== 'object') {
    return false
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsBindingReference(item, names))
  }

  if (value.type === 'Identifier') {
    return names.has(value.name)
  }

  return Object.entries(value).some(
    ([key, child]) =>
      key !== 'parent' &&
      key !== 'loc' &&
      key !== 'range' &&
      containsBindingReference(child, names),
  )
}

function declarationFeedsBlock(previousNode, node) {
  if (previousNode.type !== 'VariableDeclaration') {
    return false
  }

  if (previousNode.loc.start.line !== previousNode.loc.end.line) {
    return false
  }

  const names = new Set()
  for (const declaration of previousNode.declarations) {
    addBindingNames(declaration.id, names)
  }

  return containsBindingReference(node, names)
}

function declarationFeedsNode(sourceCode, previousNode, node) {
  if (
    previousNode.type !== 'VariableDeclaration' ||
    (previousNode.kind !== 'const' && previousNode.kind !== 'let')
  ) {
    return false
  }

  return sourceCode
    .getDeclaredVariables(previousNode)
    .some((variable) =>
      variable.references.some(
        (reference) =>
          reference.isRead() &&
          reference.identifier.range[0] >= node.range[0] &&
          reference.identifier.range[1] <= node.range[1],
      ),
    )
}

function requiresBlankLineBetween(sourceCode, previousNode, node, leadingComment) {
  const consecutiveSingleLineIfs =
    leadingComment === null &&
    isSingleLineIfStatement(previousNode) &&
    isSingleLineIfStatement(node)

  if (consecutiveSingleLineIfs) {
    return false
  }

  if (
    isPaddedMultilineStatement(sourceCode, previousNode) ||
    previousNode.type === 'IfStatement'
  ) {
    return true
  }

  if (node.type === 'IfStatement') {
    return true
  }

  const nodeIsMultilineBlock = isMultilineBlockStatement(sourceCode, node),
    nodeIsMultilineCall = isMultilineCallStatement(node),
    nodeRequiresLeadingBlankLine = isPaddedMultilineStatement(sourceCode, node),
    nodeConsumesPreviousDeclaration =
      (nodeIsMultilineBlock && declarationFeedsBlock(previousNode, node)) ||
      (nodeIsMultilineCall && declarationFeedsNode(sourceCode, previousNode, node))

  return (
    (nodeRequiresLeadingBlankLine && !nodeConsumesPreviousDeclaration) ||
    (node.loc.start.line === node.loc.end.line && leadingComment !== null)
  )
}

function getTrailingAnchor(sourceCode, node) {
  let anchor = getActualLastToken(sourceCode, node)

  for (const comment of sourceCode.getCommentsAfter(node)) {
    if (comment.loc.start.line !== anchor.loc.end.line) {
      break
    }

    anchor = comment
  }

  return anchor
}

function getAttachedLeadingComment(sourceCode, previousNode, node) {
  const comments = sourceCode
    .getCommentsBefore(node)
    .filter((comment) => comment.loc.start.line > previousNode.loc.end.line)

  let firstAttached = null,
    nextLine = node.loc.start.line

  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index]

    if (nextLine - comment.loc.end.line > 1) {
      break
    }

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
  const { sourceCode } = context
  const source = sourceCode.text,
    lineBreak = source.includes('\r\n') ? '\r\n' : '\n'

  for (let index = 1; index < statements.length; index += 1) {
    const previousNode = statements[index - 1],
      node = statements[index],
      leadingComment = getAttachedLeadingComment(sourceCode, previousNode, node)

    if (!requiresBlankLineBetween(sourceCode, previousNode, node, leadingComment)) {
      continue
    }

    const anchor = getTrailingAnchor(sourceCode, previousNode),
      target = leadingComment ?? sourceCode.getFirstToken(node),
      between = source.slice(anchor.range[1], target.range[0])

    // A detached comment between the statements is its own visual group. Leave it alone.
    if (!/^\s*$/u.test(between)) {
      continue
    }

    if (target.loc.start.line - anchor.loc.end.line === 2) {
      continue
    }

    context.report({
      fix(fixer) {
        const indent = getIndent(source, target.range[0])
        return fixer.replaceTextRange(
          [anchor.range[1], target.range[0]],
          `${lineBreak}${lineBreak}${indent}`,
        )
      },
      messageId: 'expectedSingleBlankLine',
      node,
    })
  }
}

const padMultilineBlocks = {
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
  meta: {
    docs: {
      description:
        'Require one blank line around if statements, multiline blocks, multiline calls, call chains, and types',
    },
    fixable: 'whitespace',
    messages: {
      expectedSingleBlankLine: 'Expected exactly one blank line at this code boundary.',
    },
    schema: [],
    type: 'layout',
  },
}

export default {
  meta: { name: 'stratom' },
  rules: { whitespace: padMultilineBlocks },
}
