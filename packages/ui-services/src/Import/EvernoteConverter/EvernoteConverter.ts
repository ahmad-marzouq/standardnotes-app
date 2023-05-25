import { ContentType } from '@standardnotes/common'
import { WebApplicationInterface } from '@standardnotes/services'
import { DecryptedTransferPayload, NoteContent, TagContent } from '@standardnotes/models'
import { readFileAsText } from '../Utils'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import utc from 'dayjs/plugin/utc'
import { FeatureIdentifier, NoteType } from '@standardnotes/features'
import { SuperConverterServiceInterface } from '@standardnotes/snjs/dist/@types'
dayjs.extend(customParseFormat)
dayjs.extend(utc)

const dateFormat = 'YYYYMMDDTHHmmss'

export class EvernoteConverter {
  constructor(
    protected application: WebApplicationInterface,
    protected superConverter: SuperConverterServiceInterface,
  ) {}

  async convertENEXFileToNotesAndTags(file: File, canUseSuper: boolean): Promise<DecryptedTransferPayload[]> {
    const content = await readFileAsText(file)

    const notesAndTags = this.parseENEXData(content, canUseSuper)

    return notesAndTags
  }

  parseENEXData(data: string, canUseSuper: boolean, defaultTagName = 'evernote') {
    const xmlDoc = this.loadXMLString(data, 'xml')
    const xmlNotes = xmlDoc.getElementsByTagName('note')
    const notes: DecryptedTransferPayload<NoteContent>[] = []
    const tags: DecryptedTransferPayload<TagContent>[] = []
    let defaultTag: DecryptedTransferPayload<TagContent> | undefined

    if (defaultTagName) {
      const now = new Date()
      defaultTag = {
        created_at: now,
        created_at_timestamp: now.getTime(),
        updated_at: now,
        updated_at_timestamp: now.getTime(),
        uuid: this.application.generateUUID(),
        content_type: ContentType.Tag,
        content: {
          title: defaultTagName,
          expanded: false,
          iconString: '',
          references: [],
        },
      }
    }

    for (const [index, xmlNote] of Array.from(xmlNotes).entries()) {
      const title = xmlNote.getElementsByTagName('title')[0].textContent
      const created = xmlNote.getElementsByTagName('created')[0].textContent
      const updatedNodes = xmlNote.getElementsByTagName('updated')
      const updated = updatedNodes.length ? updatedNodes[0].textContent : null
      const resources = Array.from(xmlNote.getElementsByTagName('resource'))
        .map((resourceElement) => {
          const attributes = resourceElement.getElementsByTagName('resource-attributes')[0]
          const sourceUrl = attributes.getElementsByTagName('source-url')[0].textContent
          if (!sourceUrl) {
            return
          }
          const mimeType = resourceElement.getElementsByTagName('mime')[0].textContent
          if (!mimeType) {
            return
          }
          const fileName = attributes.getElementsByTagName('file-name')[0].textContent
          if (!fileName) {
            return
          }
          const dataElement = resourceElement.getElementsByTagName('data')[0]
          const encoding = dataElement.getAttribute('encoding')
          const data = 'data:' + mimeType + ';' + encoding + ',' + dataElement.textContent?.replace(/\n/g, '')
          const splitSourceUrl = sourceUrl.split('+')
          const hash = splitSourceUrl[splitSourceUrl.length - 2]
          return {
            hash,
            data,
            fileName,
            mimeType,
          }
        })
        .filter(Boolean)

      const contentNode = xmlNote.getElementsByTagName('content')[0]
      let contentXmlString
      /** Find the node with the content */
      for (const node of Array.from(contentNode.childNodes)) {
        if (node instanceof CDATASection) {
          contentXmlString = node.nodeValue
          break
        }
      }
      if (!contentXmlString) {
        continue
      }
      const contentXml = this.loadXMLString(contentXmlString, 'html')

      const noteElement = contentXml.getElementsByTagName('en-note')[0]
      const mediaElements = noteElement.getElementsByTagName('en-media')
      for (const mediaElement of Array.from(mediaElements)) {
        const hash = mediaElement.getAttribute('hash')
        const resource = resources.find((resource) => resource && resource.hash === hash)
        if (!resource) {
          continue
        }
        const imgElement = document.createElement('img')
        imgElement.setAttribute('src', resource.data)
        imgElement.setAttribute('alt', resource.fileName)
        mediaElement.parentNode?.replaceChild(imgElement, mediaElement)
      }

      let contentHTML = noteElement.innerHTML
      const shouldStripHTML = !canUseSuper
      if (shouldStripHTML) {
        contentHTML = contentHTML.replace(/<\/div>/g, '</div>\n')
        contentHTML = contentHTML.replace(/<li[^>]*>/g, '\n')
        contentHTML = contentHTML.trim()
      }
      const text = shouldStripHTML
        ? this.stripHTML(contentHTML)
        : canUseSuper
        ? this.superConverter.convertHTMLToSuperString(contentHTML)
        : contentHTML
      const createdAtDate = created ? dayjs.utc(created, dateFormat).toDate() : new Date()
      const updatedAtDate = updated ? dayjs.utc(updated, dateFormat).toDate() : createdAtDate
      const note: DecryptedTransferPayload<NoteContent> = {
        created_at: createdAtDate,
        created_at_timestamp: createdAtDate.getTime(),
        updated_at: updatedAtDate,
        updated_at_timestamp: updatedAtDate.getTime(),
        uuid: this.application.generateUUID(),
        content_type: ContentType.Note,
        content: {
          title: !title ? `Imported note ${index + 1} from Evernote` : title,
          text,
          references: [],
          editorIdentifier: canUseSuper ? FeatureIdentifier.SuperEditor : undefined,
          noteType: canUseSuper ? NoteType.Super : undefined,
        },
      }

      if (defaultTag) {
        defaultTag.content.references.push({
          content_type: ContentType.Note,
          uuid: note.uuid,
        })
      }

      const xmlTags = xmlNote.getElementsByTagName('tag')
      for (const tagXml of Array.from(xmlTags)) {
        const tagName = tagXml.childNodes[0].nodeValue
        let tag = tags.find((tag) => {
          return tag.content.title == tagName
        })
        if (!tag) {
          const now = new Date()
          tag = {
            uuid: this.application.generateUUID(),
            content_type: ContentType.Tag,
            created_at: now,
            created_at_timestamp: now.getTime(),
            updated_at: now,
            updated_at_timestamp: now.getTime(),
            content: {
              title: tagName || `Imported tag ${index + 1} from Evernote`,
              expanded: false,
              iconString: '',
              references: [],
            },
          }
          tags.push(tag)
        }

        note.content.references.push({ content_type: tag.content_type, uuid: tag.uuid })
        tag.content.references.push({ content_type: note.content_type, uuid: note.uuid })
      }

      notes.push(note)
    }

    const allItems: DecryptedTransferPayload[] = [...notes, ...tags]
    if (allItems.length === 0) {
      throw new Error('Could not parse any notes or tags from Evernote file.')
    }
    if (defaultTag) {
      allItems.push(defaultTag)
    }

    return allItems
  }

  loadXMLString(string: string, type: 'html' | 'xml') {
    let xmlDoc
    if (window.DOMParser) {
      const parser = new DOMParser()
      xmlDoc = parser.parseFromString(string, `text/${type}`)
    } else {
      throw new Error('Could not parse XML string')
    }
    return xmlDoc
  }

  stripHTML(html: string) {
    const tmp = document.createElement('html')
    tmp.innerHTML = html
    return tmp.textContent || tmp.innerText || ''
  }
}
