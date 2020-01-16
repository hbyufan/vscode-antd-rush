import ts, {
  ClassDeclaration,
  isClassDeclaration,
  isFunctionTypeNode,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isJsxText,
  isPropertySignature,
  Node,
  SourceFile,
  FunctionDeclaration,
  isVariableStatement,
  isJsxAttribute,
  isJsxAttributes,
  VariableStatement,
  isReturnStatement,
} from 'typescript'
import { commands, Location, Position, TextDocument, window, TextEditor } from 'vscode'

import { isFromReactNodeModules } from './utils'
import { composeHandlerString } from './insertion'

/**
 * NOTE: https://github.com/microsoft/TypeScript/blob/master/lib/typescript.d.ts
 * JsxText = 11,
 * PropertySignature = 157,
 * FunctionType = 169,
 * ClassDeclaration = 244,
 * JsxSelfClosingElement = 265,
 * JsxOpeningElement = 266,
 */

/**
 * Return nearest JsxElement at position, return null if not found.
 */
export const getClosetElementNode = (document: TextDocument, position: Position): string | null => {
  const sFile = ts.createSourceFile(
    document.uri.toString(),
    document.getText(),
    ts.ScriptTarget.Latest
  )

  const offset = document.offsetAt(position)

  const parents: Node[] = getNodeWithParentsAt(sFile, offset)

  if (!parents.length) return null
  const [jsxElement, jsxText] = parents.slice(-2) // TS do not support array deconstruction operator?

  if (
    (isJsxOpeningElement(jsxElement) || isJsxSelfClosingElement(jsxElement)) &&
    (isJsxText(jsxText) || isJsxAttribute(jsxText) || isJsxAttributes(jsxText))
  ) {
    const componentName = jsxElement.tagName.getText(sFile)
    // TODO: not right for rename import
    return componentName
  }

  return null
}

/**
 * Return nearest userland component with condition
 */
export const getComponentElement = async <T extends Node>(
  document: TextDocument,
  position: Position,
  condition: (parent: Node, document: TextDocument) => Promise<boolean>,
  direction: 'inward' | 'outward'
): Promise<T | null> => {
  const sFile = ts.createSourceFile(
    document.uri.toString(),
    document.getText(),
    ts.ScriptTarget.Latest
  )

  const offset = document.offsetAt(position)
  // parents should starts from the closest
  let parents: Node[] = getNodeWithParentsAt(sFile, offset)
  if (direction === 'outward') parents = parents.reverse()

  const typeComponentNodePromises = parents.map(parent => {
    return condition(parent, document)
  })

  const typeJudgementResult = await Promise.all(typeComponentNodePromises)
  const targetNodeIndex = typeJudgementResult.findIndex(Boolean)
  if (targetNodeIndex === -1) return null
  const typeComponentNode = parents[targetNodeIndex] as T
  return typeComponentNode
}

/**
 * Insert string to class component
 * This function adapt indent and fill in handler template
 */
export const insertStringToClassComponent = async (args: {
  editor: TextEditor
  document: TextDocument
  classNode: ClassDeclaration
  symbolPosition: Position
  fullHandlerName: string
  indent: number
  handlerParams: FunctionParam[]
}): Promise<Position | null> => {
  const {
    editor,
    document,
    indent,
    classNode,
    symbolPosition,
    fullHandlerName,
    handlerParams,
  } = args
  const offset = document.offsetAt(symbolPosition)

  const memberContainsSymbol = classNode.members.find(member => {
    return offsetContains(offset, member.pos, member.end)
  })

  if (!memberContainsSymbol) return null

  // memberContainsSymbol.pos point to the previous member ending position
  const insertAt = document.positionAt(memberContainsSymbol.pos)

  await editor.edit(builder => {
    builder.insert(insertAt, composeHandlerString(fullHandlerName, handlerParams, indent, 'class'))
  })

  return insertAt
}

/**
 * Insert string to functional component
 * This function adapt indent and fill in handler template
 */
export const insertStringToFunctionalComponent = async (args: {
  editor: TextEditor
  document: TextDocument
  indent: number
  functionalNode: FunctionDeclaration | VariableStatement
  symbolPosition: Position
  fullHandlerName: string
  handlerParams: FunctionParam[]
}): Promise<Position | null> => {
  const {
    editor,
    document,
    indent,
    functionalNode,
    symbolPosition,
    fullHandlerName,
    handlerParams,
  } = args

  const sFile = ts.createSourceFile(
    document.uri.toString(),
    document.getText(),
    ts.ScriptTarget.Latest
  )

  // find outermost statement
  const parents = getNodeWithParentsAt(sFile, document.offsetAt(symbolPosition))
  // exclude outermost component, cause we should insert handler in it
  // TODO: simple workaround
  const closetStatement = parents.slice(1).find(parent => {
    return isVariableStatement(parent) || isReturnStatement(parent)
  })

  if (!closetStatement) return null
  const insertAt = document.positionAt(closetStatement.pos)
  editor.edit(builder => {
    builder.insert(
      insertAt,
      composeHandlerString(fullHandlerName, handlerParams, indent, 'functional')
    )
  })

  return insertAt
}

/**
 * Get ast node at postion, return with it's parent nodes
 */
export const isClassExtendsReactComponent = async (
  node: Node,
  document: TextDocument
): Promise<boolean> => {
  if (!isClassDeclaration(node)) return false
  if (!node.heritageClauses?.length) return false
  const isReactClassPromises = node.heritageClauses.map(async heritage => {
    const expressions = heritage.types.map(type => type.expression)
    const isFromReactPromises = expressions.map(async expression => {
      const position = document.positionAt(expression.pos + 1)
      const typeDefinition = await commands.executeCommand<Location[]>(
        'vscode.executeTypeDefinitionProvider',
        document.uri,
        position
      )

      const hasDefinitionFromReact = !!typeDefinition?.some(definition =>
        isFromReactNodeModules(definition.uri.path)
      )

      return hasDefinitionFromReact
    })

    const result = await Promise.all(isFromReactPromises)
    return result.some(Boolean)
  })

  const isReactClassResult = await Promise.all(isReactClassPromises)
  const isReactClass = isReactClassResult.some(Boolean)

  return isReactClass
}

/**
 * Get ast node at postion, return with it's parent nodes
 */
// TODO: implement by traverseTsAst
const getNodeWithParentsAt = (node: Node, offset: number, initialParents?: Node[]) => {
  const parents: Node[] = initialParents || []
  let hasFind = false
  node.forEachChild(child => {
    const start = child.pos
    const end = child.end
    if (offsetContains(offset, start, end)) {
      parents.push(child)
      hasFind = true
    }
    return
  })

  if (hasFind) {
    getNodeWithParentsAt(parents[parents.length - 1], offset, parents)
  }

  return parents
}

/**
 * Whether offset between start and end
 */
const offsetContains = (offset: number, startOrEnd: number, endOrStart: number) => {
  const [start, end] = startOrEnd > endOrStart ? [endOrStart, startOrEnd] : [startOrEnd, endOrStart]
  return start <= offset && end >= offset
}

/**
 * Create empty function from function dts
 */

export interface FunctionParam {
  type: string
  text: string
}

export const buildTsFromDts = (dtsString: string): FunctionParam[] | null => {
  // NOTE: definition is a property, it should be wrapped in type
  const dtsTypeString = `type DUMMY = {
  ${dtsString}
}`

  const sCode: Node = ts.createSourceFile('', dtsTypeString, ts.ScriptTarget.Latest)
  let handlerName: string = ''
  const paramTexts: string[] = []

  traverseWithParents(sCode, (node, stack) => {
    if (isPropertySignature(node)) {
      if (!node.type) return
      handlerName = node.name.getText(sCode as SourceFile)
      if (isFunctionTypeNode(node.type)) {
        const typeParamsText = node.type.parameters.map(p => {
          // TODO: lacks ts type, only satisfied JS
          return p.name.getText(sCode as SourceFile)
        })
        paramTexts.push(...typeParamsText)
      }
    }
  })

  return paramTexts.map(param => ({ type: '', text: param }))
}

/**
 * Traverse ts ast
 */
interface TraverseActions {
  enter?: Function
  leave?: Function
}

const noop = () => {}

export const traverseTsAst = (entryNode: Node, traverseActions: TraverseActions) => {
  const { enter: _enter, leave: _leave } = traverseActions
  const enter = typeof _enter === 'function' ? _enter : noop
  const leave = typeof _leave === 'function' ? _leave : noop

  const traverseNode = (node: Node) => {
    enter(node)
    node.forEachChild(traverseNode)
    leave(node)
  }

  traverseNode(entryNode)
}

/**
 * Traverse node with parents
 */
export const traverseWithParents = (
  entryNode: Node,
  visitor: (node: Node, stack: Node[]) => boolean | void
) => {
  const nodeStack: Node[] = []

  const enter = (node: Node) => {
    nodeStack.push(node)
    visitor(node, nodeStack)
  }

  const leave = (node: Node) => {
    const topNode = nodeStack.pop()
  }

  traverseTsAst(entryNode, {
    enter: enter,
    leave: leave,
  })
}
