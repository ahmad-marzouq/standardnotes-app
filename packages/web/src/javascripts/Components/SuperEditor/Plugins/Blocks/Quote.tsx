import { $wrapNodes } from '@lexical/selection'
import { $getSelection, $isRangeSelection, LexicalEditor } from 'lexical'
import { $createQuoteNode } from '@lexical/rich-text'

export function GetQuoteBlock(editor: LexicalEditor) {
  return {
    name: 'Quote',
    iconName: 'quote',
    keywords: ['block quote'],
    onSelect: () =>
      editor.update(() => {
        const selection = $getSelection()
        if ($isRangeSelection(selection)) {
          $wrapNodes(selection, () => $createQuoteNode())
        }
      }),
  }
}
