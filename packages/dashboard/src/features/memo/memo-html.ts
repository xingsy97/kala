const ALLOWED_TAGS = new Set(['DIV','P','BR','B','STRONG','I','EM','U','S','UL','OL','LI','BLOCKQUOTE','PRE','CODE','H1','H2','H3','H4','A','IMG'])

export function sanitizeMemoHtml(input: string): string {
  if (typeof DOMParser === 'undefined') return input
  const parsed = new DOMParser().parseFromString(input, 'text/html')
  const clean = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.COMMENT_NODE) { child.remove(); continue }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const element = child as HTMLElement
      clean(element)
      if (!ALLOWED_TAGS.has(element.tagName)) { element.replaceWith(...Array.from(element.childNodes)); continue }
      const src = element.tagName === 'IMG' ? element.getAttribute('src') ?? '' : ''
      const href = element.tagName === 'A' ? element.getAttribute('href') ?? '' : ''
      for (const attribute of Array.from(element.attributes)) element.removeAttribute(attribute.name)
      if (element.tagName === 'IMG') {
        if (/^data:image\/(png|jpeg|webp|gif);base64,/u.test(src)) element.setAttribute('src', src)
        else element.remove()
      }
      if (element.tagName === 'A' && /^https?:\/\//u.test(href)) {
        element.setAttribute('href', href); element.setAttribute('rel', 'noreferrer noopener'); element.setAttribute('target', '_blank')
      }
    }
  }
  clean(parsed.body)
  return parsed.body.innerHTML
}
