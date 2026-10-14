import type { ChatMessage } from '@shared/types'
import { normalizeBaseURL } from '@shared/providers'

/**
 * 所有服务商都走 OpenAI 兼容协议，所以这里只有一套调用逻辑。
 * 这是刻意的选择：只学一套协议，加新服务商只需要在 providers.ts 里加一行。
 */

export interface ProviderConfig {
  baseURL: string
  apiKey: string
  model: string
}

export class ProviderError extends Error {
  constructor(
    message: string,
    /** 给界面用的处理建议 */
    readonly advice: string,
    /** HTTP 状态码，网络层错误时为 0 */
    readonly status: number
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null }
    finish_reason?: string | null
  }>
}

function endpoint(baseURL: string, path: string): string {
  return `${normalizeBaseURL(baseURL)}${path}`
}

/** 把服务商返回的错误，翻译成用户看得懂的话 */
function translateError(status: number, bodyText: string): ProviderError {
  let detail = ''
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: string }
      message?: string
    }
    detail = parsed.error?.message ?? parsed.message ?? ''
  } catch {
    detail = bodyText.slice(0, 200)
  }

  const suffix = detail ? `（服务商原话：${detail}）` : ''

  switch (status) {
    case 401:
      return new ProviderError(
        `密钥无效或已过期${suffix}`,
        '去设置里重新粘贴一次密钥，注意不要带空格。',
        status
      )
    case 403:
      return new ProviderError(
        `密钥没有权限访问这个模型${suffix}`,
        '换一个模型试试，或者检查这个密钥是否开通了对应权限。',
        status
      )
    case 402:
      return new ProviderError(
        `账户余额不足${suffix}`,
        '去服务商控制台充值后再试。',
        status
      )
    case 404:
      return new ProviderError(
        `接口地址或模型名不对${suffix}`,
        '检查设置里的"接口地址"是否填对，模型名是否拼写正确。',
        status
      )
    case 429:
      return new ProviderError(
        `请求太频繁或超出额度${suffix}`,
        '等十几秒再试。',
        status
      )
    default:
      if (status >= 500) {
        return new ProviderError(
          `服务商那边出问题了${suffix}`,
          '这是服务商自己的故障，过一会儿再试。',
          status
        )
      }
      return new ProviderError(
        `请求失败（HTTP ${status}）${suffix}`,
        '检查设置里的接口地址和服务商选择。',
        status
      )
  }
}

async function postChat(
  config: ProviderConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Response> {
  if (!config.apiKey) {
    throw new ProviderError('还没有填密钥', '去设置里填上你的 API Key。', 0)
  }
  if (!config.baseURL) {
    throw new ProviderError('还没有填接口地址', '去设置里选择服务商或填上接口地址。', 0)
  }

  let response: Response
  try {
    response = await fetch(endpoint(config.baseURL, '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({ ...body, model: config.model }),
      signal
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err
    throw new ProviderError(
      `连不上服务器：${err instanceof Error ? err.message : String(err)}`,
      '检查网络及系统代理是否正常，或更换可连接的服务商。',
      0
    )
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw translateError(response.status, text)
  }

  return response
}

/**
 * 流式对话：一边生成一边把文字交出去。
 * onDelta 每次收到一小段就调一次，界面上就是"一个字一个字往外冒"的效果。
 */
export async function streamChat(
  config: ProviderConfig,
  messages: ChatMessage[],
  onDelta: (text: string) => void | Promise<void>,
  signal?: AbortSignal
): Promise<string> {
  const response = await postChat(
    config,
    {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      temperature: 0.7
    },
    signal
  )

  if (!response.body) {
    throw new ProviderError('服务商没有返回内容', '换一个模型或服务商试试。', 0)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let full = ''
  let completed = false

  const consume = async (lines: string[]): Promise<void> => {
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line || line.startsWith(':')) continue
      if (!line.startsWith('data:')) continue

      const payload = line.slice(5).trim()
      if (payload === '[DONE]') { completed = true; continue }

      let chunk: ChatCompletionChunk
      try {
        chunk = JSON.parse(payload) as ChatCompletionChunk
      } catch {
        continue
      }
      if (chunk.choices?.[0]?.finish_reason) completed = true

      const delta = chunk.choices?.[0]?.delta
      if (!delta) continue

      // 有些模型（比如推理模型）会把思考过程放在 reasoning_content 里，这里只取正式回答
      const piece = delta.content ?? ''
      if (piece) {
        full += piece
        await onDelta(piece)
      }
    }
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      await consume(lines)
    }
    buffer += decoder.decode()
    if (buffer.trim()) await consume([buffer])
    if (!completed) throw new ProviderError('服务商回复中途断开', '回复尚未完成，请稍后重新提问。', 0)
    if (!full.trim()) throw new ProviderError('服务商没有返回正文', '请检查模型名或更换模型。', 0)
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return full
}

/**
 * 测试连接：发一句最短的话，确认密钥、地址、模型三者都对。
 */
export async function testConnection(
  config: ProviderConfig,
  signal?: AbortSignal
): Promise<{ reply: string }> {
  const response = await postChat(
    config,
    {
      messages: [{ role: 'user', content: '请只回复两个字：你好' }],
      stream: false,
      max_tokens: 16
    },
    signal
  )

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const reply = data.choices?.[0]?.message?.content?.trim() ?? ''
  return { reply: reply || '（对方返回了空内容，但连接是通的）' }
}

/** 用于生成入口问题等短结构化结果，不进入对话流水。 */
export async function completeChat(
  config: ProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  maxTokens = 700
): Promise<string> {
  const response = await postChat(
    config,
    {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      temperature: 0.4,
      max_tokens: maxTokens
    },
    signal
  )
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>
  }
  if (data.choices?.[0]?.finish_reason === 'length') {
    throw new ProviderError('模型输出达到长度上限，内容不完整', '请缩小页码范围或换用允许更长输出的模型，再续接重试。', 0)
  }
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) throw new ProviderError('没有生成入口问题', '再试一次，或直接选一个示例问题。', 0)
  return content
}
