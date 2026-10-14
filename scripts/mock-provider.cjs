/**
 * 一个"假的 AI 服务商"，只为自动化验证用。
 *
 * 它照着 OpenAI 的接口规范返回数据（包括流式格式），
 * 所以它能真实地检验：请求头、请求体、SSE 解析、落库、界面渲染这一整条链路。
 * 真正的模型换成一个固定回复，让验证结果可复现。
 *
 * 它只在验证脚本里启动，正常运行软件时不会用到。
 */

const { createServer } = require('node:http')

const REPLY =
  '这个问题的关键在于：减去最大值之后，最大的那一项变成 e 的 0 次方，也就是 1，' +
  '其余各项都小于 1，于是不会溢出。而且分子分母同时缩小了相同的倍数，最终结果不变。'

const ENTRY_REPLY = JSON.stringify({
  entries: [
    { question: 'AI 为什么能认出一张猫的照片？', why: '先从看得见的例子入手' },
    { question: '神经网络怎样从错误里调整自己？', why: '能看懂它如何一步步学会' },
    { question: '为什么模型会把相关性当成原因？', why: '开始碰到它真正的边界' }
  ]
})

const NOTE_REPLY = JSON.stringify({
  hasNewContent: true,
  blocks: [
    {
      blockType: 'claim',
      content: '减去最大值会让指数的最大项变成 1，其他项不大于 1，因此计算时不容易溢出；分子分母同乘相同因子，结果不变。',
      groundedIn: 'conversation',
      isNewRelativeToExisting: true
    }
  ],
  nodeAction: 'create',
  nodePatch: { title: 'softmax 为什么减去最大值', masteryDelta: 2 },
  edges: [],
  discarded: [{ reason: '重复已有' }]
})

const NOTE_EMPTY_REPLY = JSON.stringify({
  hasNewContent: false,
  blocks: [],
  nodeAction: 'none',
  nodePatch: { title: '', masteryDelta: 0 },
  edges: [],
  discarded: [{ reason: '无新信息' }]
})

function sseChunk(text) {
  return `data: ${JSON.stringify({
    id: 'mock-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
  })}\n\n`
}

function startMockProvider() {
  const requests = []

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf-8')
      let body = {}
      try {
        body = JSON.parse(bodyText)
      } catch {
        /* 不是 JSON 就当作空 */
      }

      requests.push({
        url: req.url,
        method: req.method,
        authorization: req.headers['authorization'] ?? '',
        model: body.model,
        stream: !!body.stream,
        messages: (body.messages ?? []).map((m) => ({ role: m.role, content: m.content }))
      })

      if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'not found' } }))
        return
      }

      // 没带密钥就回 401，用来验证错误提示这条路也是通的
      if (!req.headers['authorization'] || req.headers['authorization'] === 'Bearer sk-expired') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Invalid API key' } }))
        return
      }

      if (body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })
        // 故意拆成几段发，模拟真实的逐字输出
        const parts = REPLY.match(/.{1,12}/g) ?? [REPLY]
        let i = 0
        const timer = setInterval(() => {
          if (i >= parts.length) {
            clearInterval(timer)
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          res.write(sseChunk(parts[i]))
          i++
        }, 5)
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        const system = body.messages?.[0]?.content ?? ''
        const user = body.messages?.[1]?.content ?? ''
        let content = system.includes('挑三个起点') ? ENTRY_REPLY
          : system.includes('知识萃取器') ? (user.includes('【已有笔记】（空）') ? NOTE_REPLY : NOTE_EMPTY_REPLY)
          : system.includes('检验理解的应用题') ? JSON.stringify({
            question: '如果 softmax 的输入里有一个数特别大，直接计算会出什么问题？怎样在不改变结果的前提下处理？'
          })
          : system.includes('学习复习的判题员') ? JSON.stringify({
            correct: true, quality: 4, masteryDelta: 1,
            feedback: '你指出了指数溢出，并说明了减去最大值为什么不改变最终比例。'
          })
          : system.includes('标记可观察的学习信号') ? JSON.stringify({ signals: ['boundary_question'] })
          : system.includes('判断学习者的几条支线') ? JSON.stringify({ threads: [...user.matchAll(/rootNodeId：([^\n]+)/g)].map((match) => ({
            rootNodeId: match[1].trim(),
            isClosed: !user.includes(`rootNodeId：${match[1]}\n最初的问题：注意力机制`),
            conclusion: user.includes(`rootNodeId：${match[1]}\n最初的问题：注意力机制`) ? '' : '这个问题已经解释清楚。',
            stoppedAt: user.includes(`rootNodeId：${match[1]}\n最初的问题：注意力机制`) ? '浮点数的二进制表示还没解释' : '',
            nextStep: user.includes(`rootNodeId：${match[1]}\n最初的问题：注意力机制`) ? '从浮点数的二进制表示继续' : ''
          })) })
          : system.includes('资料逐字转录员') ? 'SCANNED_PAGE_ANCHOR is only in pixels'
          : '你好'
        // Library fixtures are synthetic and only available in this local test provider.
        if (system.includes('只转录图片里的文字')) content = '细胞膜由磷脂双分子层构成。线粒体是细胞呼吸的主要场所。[无法辨认]'
        if (system.includes('手写笔记整理员')) content = JSON.stringify({ notes: [
          { category: '细胞结构', title: '细胞膜', content: '细胞膜由磷脂双分子层构成。', evidence: '细胞膜由磷脂双分子层构成' },
          { category: '细胞代谢', title: '线粒体', content: '线粒体是细胞呼吸的主要场所。', evidence: '线粒体是细胞呼吸的主要场所' }
        ] })
        if (system.includes('书籍阅读图谱整理员')) content = typeof user === 'string' && user.split('<原文>')[1]?.includes('江月') ? JSON.stringify({
          characters: [{ name: '林夏', description: '林舟的女儿', evidence: '林夏在钟楼遇见江月' }, { name: '江月', description: '帮助林夏的人', evidence: '江月帮助林夏找到了图书馆' }],
          events: [{ title: '钟楼相遇', summary: '林夏遇见江月并得到帮助。', characters: ['林夏', '江月'], evidence: '林夏在钟楼遇见江月' }],
          relations: [{ from: '江月', to: '林夏', label: '帮助', evidence: '江月帮助林夏找到了图书馆' }]
        }) : JSON.stringify({
          characters: [{ name: '林舟', description: '林夏的父亲', evidence: '林舟牵着女儿林夏走进旧城' }, { name: '林夏', description: '林舟的女儿', evidence: '林夏是林舟的女儿' }],
          events: [{ title: '走进旧城', summary: '林舟和林夏来到旧城。', characters: ['林舟', '林夏'], evidence: '林舟牵着女儿林夏走进旧城' }],
          relations: [{ from: '林舟', to: '林夏', label: '父女', evidence: '林夏是林舟的女儿' }]
        })
        res.end(
          JSON.stringify({
            id: 'mock-1',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
          })
        )
      }
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        baseURL: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r))
      })
    })
  })
}

module.exports = { startMockProvider, MOCK_REPLY: REPLY, MOCK_ENTRIES: JSON.parse(ENTRY_REPLY).entries }
