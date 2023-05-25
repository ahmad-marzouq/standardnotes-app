import { createHeadlessEditor } from '@lexical/headless'
import { $convertToMarkdownString } from '@lexical/markdown'
import { SuperConverterServiceInterface } from '@standardnotes/snjs'
import {
  $createParagraphNode,
  $getRoot,
  $insertNodes,
  $nodesOfType,
  LexicalEditor,
  LexicalNode,
  ParagraphNode,
} from 'lexical'
import BlocksEditorTheme from '../Lexical/Theme/Theme'
import { BlockEditorNodes } from '../Lexical/Nodes/AllNodes'
import { MarkdownTransformers } from '../MarkdownTransformers'
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html'

export class HeadlessSuperConverter implements SuperConverterServiceInterface {
  private editor: LexicalEditor

  constructor() {
    this.editor = createHeadlessEditor({
      namespace: 'BlocksEditor',
      theme: BlocksEditorTheme,
      editable: false,
      onError: (error: Error) => console.error(error),
      nodes: [...BlockEditorNodes],
    })
  }

  convertFromSuperStringToFormat(superString: string, format: 'txt' | 'md' | 'html' | 'json'): string {
    if (superString.length === 0) {
      return superString
    }

    this.editor.setEditorState(this.editor.parseEditorState(superString))

    let content: string | undefined

    this.editor.update(
      () => {
        switch (format) {
          case 'txt':
          case 'md': {
            const paragraphs = $nodesOfType(ParagraphNode)
            for (const paragraph of paragraphs) {
              if (paragraph.isEmpty()) {
                paragraph.remove()
              }
            }
            content = $convertToMarkdownString(MarkdownTransformers)
            break
          }
          case 'html':
            content = $generateHtmlFromNodes(this.editor)
            break
          case 'json':
          default:
            content = superString
            break
        }
      },
      { discrete: true },
    )

    if (!content) {
      throw new Error('Could not export note')
    }

    return content
  }

  convertHTMLToSuperString = (html: string): string => {
    if (!html) {
      throw new Error('HTML is empty')
    }

    this.editor.update(
      () => {
        $getRoot().clear()
      },
      {
        discrete: true,
      },
    )

    this.editor.update(
      () => {
        const parser = new DOMParser()
        const dom = parser.parseFromString(html, 'text/html')
        const generatedNodes = $generateNodesFromDOM(this.editor, dom)
        const nodesToInsert: LexicalNode[] = []
        generatedNodes.forEach((node) => {
          const type = node.getType()

          // Wrap text & link nodes with paragraph since they can't
          // be top-level nodes in Super
          if (type === 'text' || type === 'link') {
            const paragraphNode = $createParagraphNode()
            paragraphNode.append(node)
            nodesToInsert.push(paragraphNode)
            return
          } else {
            nodesToInsert.push(node)
          }
        })
        $getRoot().select()
        $insertNodes(nodesToInsert.concat($createParagraphNode()))
      },
      {
        discrete: true,
      },
    )

    return JSON.stringify(this.editor.getEditorState())
  }
}
