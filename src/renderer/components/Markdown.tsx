import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

/**
 * 渲染 AI 回复里的简单排版（加粗、列表、代码）。
 * 内容全部来自本地数据库，经过清洗后再插入，避免任何意外注入。
 */
function render(markdown: string): string {
  const raw = marked.parse(markdown, { async: false }) as string
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'del', 'code', 'pre',
      'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'a', 'hr', 'table',
      'thead', 'tbody', 'tr', 'th', 'td'
    ],
    ALLOWED_ATTR: ['href', 'title']
  })
}

export function Markdown({ text }: { text: string }): React.JSX.Element {
  const html = useMemo(() => render(text), [text])

  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
