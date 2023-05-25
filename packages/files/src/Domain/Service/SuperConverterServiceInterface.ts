export interface SuperConverterServiceInterface {
  convertFromSuperStringToFormat: (superString: string, toFormat: 'txt' | 'md' | 'html' | 'json') => string
  convertHTMLToSuperString: (html: string) => string
}
