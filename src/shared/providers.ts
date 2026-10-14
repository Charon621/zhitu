import type { ProviderPreset } from './types'

/**
 * 服务商预设表。
 * 这些都是 OpenAI 兼容接口，所以代码里只有一套调用逻辑，区别只在地址和模型名。
 */
export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek（深度求索）',
    hint: '便宜、中文好、国内直连，推荐',
    baseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    altModels: ['deepseek-reasoner'],
    consoleURL: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'moonshot',
    label: 'Kimi（月之暗面）',
    hint: '长文本强，回答细致',
    baseURL: 'https://api.moonshot.cn',
    defaultModel: 'moonshot-v1-8k',
    altModels: ['moonshot-v1-32k', 'moonshot-v1-128k'],
    consoleURL: 'https://platform.moonshot.cn/console/api-keys'
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    hint: '国内老牌，稳定',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
    altModels: ['glm-4-air', 'glm-4-flash'],
    consoleURL: 'https://bigmodel.cn/usercenter/apikeys'
  },
  {
    id: 'dashscope',
    label: '阿里通义千问',
    hint: '阿里云，生态全',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    altModels: ['qwen-turbo', 'qwen-max'],
    consoleURL: 'https://bailian.console.aliyun.com/'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    hint: '需要能访问境外网络',
    baseURL: 'https://api.openai.com',
    defaultModel: 'gpt-4o-mini',
    altModels: ['gpt-4o'],
    consoleURL: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'custom',
    label: '其他（自己填地址）',
    hint: '任何 OpenAI 兼容的接口，比如公司内网或本地模型',
    baseURL: '',
    defaultModel: '',
    altModels: [],
    consoleURL: '',
    needsBaseURL: true
  }
]

export function getProvider(id: string): ProviderPreset {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]
}

/**
 * 把用户填的地址整理成规范的 baseURL：
 * - 去掉尾部斜杠
 * - 如果用户填到了 /chat/completions，把它去掉，避免出现两个
 */
export function normalizeBaseURL(raw: string): string {
  let url = (raw || '').trim()
  if (!url) return ''
  url = url.replace(/\/+$/, '')
  url = url.replace(/\/chat\/completions$/i, '')
  url = url.replace(/\/v1\/chat\/completions$/i, '/v1')
  return url
}
