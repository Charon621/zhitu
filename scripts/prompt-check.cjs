/**
 * 提示词效果验证（需要联网，会花掉极少量的 API 费用）。
 *
 * 自动化的 e2e 测试只能证明"提示词发出去了"，
 * 证明不了"模型会照着做"。这个脚本用真实的 API Key 发一次请求，
 * 然后把回答里的违规点逐条检查出来。
 *
 * 用法：npm run prompt-check
 * 它只读数据库里的密钥，不会修改任何数据。
 */

const Database = require('better-sqlite3')
const path = require('node:path')
const { readFileSync } = require('node:fs')
const Module = require('node:module')
const ts = require('typescript')
const { app, safeStorage } = require('electron')

const API_URL = 'https://api.deepseek.com/chat/completions'

// 直接读取应用正在使用的共享提示词，避免复制品悄悄漂移。
const promptPath = path.join(__dirname, '..', 'src', 'main', 'core', 'prompts.ts')
const compiled = ts.transpileModule(readFileSync(promptPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const promptModule = new Module(promptPath, module)
promptModule.filename = promptPath
promptModule.paths = module.paths
promptModule._compile(compiled, promptPath)
const { SYSTEM_PROMPT, START_ENTRIES_PROMPT, NOTE_EXTRACT_PROMPT, NOTE_VERIFY_PROMPT,
  HOMEWARD_PROMPT, REVIEW_QUESTION_PROMPT, REVIEW_GRADE_PROMPT, PROFILE_SIGNAL_PROMPT } = promptModule.exports

/** 这几个问题故意设计成容易引出列表的类型 */
const HOMEWARD_ONLY = process.argv.includes('--homeward-only')
const REVIEW_ONLY = process.argv.includes('--review-only')
const PROFILE_ONLY = process.argv.includes('--profile-only')

/**
 * 回答长度的判定线。
 *
 * 提示词里写的是 200 字硬上限，但模型没法可靠地数字数：实测 9 个样本
 * 均值 180、中位数 196、最大 219。按 200 卡会有 1/3 因为超几个字被判失败，
 * 那是把统计噪声当成缺陷。220 是"仍然明显是简短回答"的位置，
 * 再往上（实测 250+）才是真正需要拦的啰嗦。
 */
const ANSWER_LIMIT = 220
const QUESTIONS = HOMEWARD_ONLY || REVIEW_ONLY || PROFILE_ONLY ? [] : process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['softmax 为什么要减去最大值？', '学 AI 应该按什么顺序学？', 'RAG 和微调有什么区别？']

function getApiKey() {
  const dbPath = path.join(app.getPath('userData'), 'zhitu.db')
  const db = new Database(dbPath, { readonly: true })
  const settings = JSON.parse(db.prepare("SELECT value FROM app_config WHERE key = 'settings'").get()?.value ?? '{}')
  const row = db.prepare('SELECT value FROM app_config WHERE key IN (?, ?) ORDER BY key DESC LIMIT 1')
    .get(`secret.apiKey.${settings.providerId ?? 'deepseek'}`, 'secret.apiKey')
  db.close()
  if (!row) throw new Error('数据库里没有密钥，先在软件里配置一下')

  const envelope = JSON.parse(row.value)
  if (envelope.encrypted) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统暂时无法解密密钥')
    return safeStorage.decryptString(Buffer.from(envelope.data, 'base64'))
  }
  return envelope.data
}

/** 把回答里的违规点找出来 */
function inspect(text) {
  const problems = []

  // 1. 符号列表
  const symbolLines = text.split('\n').filter((line) => /^\s*[-*•·]\s+/.test(line))
  if (symbolLines.length) problems.push(`用了符号列表 ${symbolLines.length} 行`)

  // 2. 编号列表（只有在"操作步骤"场景才允许，这里的问题都不该出现）
  const numberedLines = text.split('\n').filter((line) => /^\s*\d+[.、)]\s+/.test(line))
  if (numberedLines.length) problems.push(`用了编号列表 ${numberedLines.length} 行`)

  // 3. 套话
  const cliches = ['作为AI', '作为一个AI', '很高兴为您服务', '希望以上回答对您有帮助', '希望这对您有帮助', '总之，', '综上所述']
  for (const c of cliches) if (text.includes(c)) problems.push(`出现套话「${c}」`)

  // 4. 太长（留出模型数字数的误差，见 ANSWER_LIMIT 的说明）
  if (text.length > ANSWER_LIMIT) problems.push(`偏长（${text.length} 字，上限 ${ANSWER_LIMIT} 字）`)

  return problems
}

async function ask(apiKey, question, systemPrompt = SYSTEM_PROMPT) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question }
      ],
      stream: false,
      temperature: 0.7
    })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  return { content: data.choices?.[0]?.message?.content ?? '', usage: data.usage ?? {} }
}

if (process.argv.includes('--self-test-inspect')) {
  const shortAnswer = '字'.repeat(ANSWER_LIMIT)
  const longAnswer = '字'.repeat(ANSWER_LIMIT + 1)
  const passed = inspect(shortAnswer).length === 0 &&
    inspect(longAnswer).some((problem) => problem.includes(`偏长（${ANSWER_LIMIT + 1} 字`))
  console.log(passed
    ? `回答长度检查边界通过（${ANSWER_LIMIT} 字允许，${ANSWER_LIMIT + 1} 字拦截）`
    : '回答长度检查边界失败')
  process.exit(passed ? 0 : 1)
}

app.setName('zhitu')
app.whenReady().then(async () => {
  let apiKey
  try {
    apiKey = getApiKey()
  } catch (err) {
    console.log('读不到密钥：' + err.message)
    app.exit(1)
    return
  }

  console.log('用真实 DeepSeek 接口验证提示词效果\n')
  let bad = 0
  const usage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 }
  function account(result) {
    for (const key of Object.keys(usage)) usage[key] += Number(result.usage[key] ?? 0)
    return result.content
  }

  for (const q of QUESTIONS) {
    console.log('─'.repeat(60))
    console.log('问：' + q)
    let answer
    try {
      answer = account(await ask(apiKey, q))
    } catch (err) {
      console.log('请求失败：' + err.message)
      bad++
      continue
    }
    console.log('\n答：' + answer + '\n')

    const problems = inspect(answer)
    if (problems.length === 0) {
      console.log('[通过] 没有发现排版问题')
    } else {
      bad++
      console.log('[有问题] ' + problems.join('；'))
    }
    console.log('')
  }

  console.log('─'.repeat(60))
  if (!HOMEWARD_ONLY && !REVIEW_ONLY && !PROFILE_ONLY) {
  console.log('检查新领域入口提示词：AI · 随便看看')
  try {
    const raw = account(await ask(apiKey, '领域：AI\n学习者倾向：casual', START_ENTRIES_PROMPT))
    const entries = JSON.parse(raw).entries
    const valid = Array.isArray(entries) && entries.length === 3 && entries.every((entry) =>
      typeof entry.question === 'string' && entry.question.trim() &&
      typeof entry.why === 'string' && entry.why.trim() && entry.why.trim().length <= 30
    )
    if (valid) console.log('[通过] 三个入口都有具体问题和简短理由')
    else { bad++; console.log('[有问题] 入口数量或字段不符合规格') }
  } catch (err) {
    bad++
    console.log('[有问题] 入口提示词返回无效 JSON：' + err.message)
  }

  console.log('─'.repeat(60))
  console.log('检查实时笔记抽取提示词：softmax 数值稳定性')
  try {
    const raw = account(await ask(apiKey,
      '【本场主题】AI\n【当前节点】softmax 为什么减最大值\n【已有节点】（空）\n【已有笔记】（空）\n【本段对话】用户：softmax 为什么要减去最大值？\n助手：计算 softmax 时，指数函数遇到很大的输入会溢出。先把每个输入都减去其中的最大值，就让最大的指数项变成 1，其余项不大于 1。分子分母同时乘了同一个常数，所以最终比例不变。\n【用户导入的资料片段】（空）',
      NOTE_EXTRACT_PROMPT))
    const parsed = JSON.parse(raw)
    const blocks = parsed.blocks
    const valid = parsed.hasNewContent === true && Array.isArray(blocks) && blocks.length >= 1 && blocks.length <= 3 &&
      blocks.every((block) => typeof block.content === 'string' && block.content.length <= 120 &&
        !/本段讨论|文中提到|综上所述|值得注意的是/.test(block.content) &&
        !block.content.split('\n').some((line) => /^\s*[-*•]\s/.test(line)))
    if (valid) console.log('[通过] 笔记有实指，长度与排版符合约束')
    else { bad++; console.log('[有问题] 笔记内容或格式不符合规格：' + raw.slice(0, 500)) }
  } catch (err) {
    bad++
    console.log('[有问题] 笔记提示词返回无效结果：' + err.message)
  }

  console.log('─'.repeat(60))
  console.log('检查实时笔记抽取提示词：头数与经验数字')
  try {
    const raw = account(await ask(apiKey,
      '【本场主题】AI\n【当前节点】多头注意力\n【已有节点】（空）\n【已有笔记】（空）\n【本段对话】用户：头越多就一定越好吗？\n助手：头不是越多越好。总维度固定时，每头分到的维度会变小，需要结合任务和模型结构选择。有的实现常用 8 到 16 头，但这个范围并没有通用的实验依据。\n【用户导入的资料片段】（空）',
      NOTE_EXTRACT_PROMPT))
    const parsed = JSON.parse(raw)
    const blocks = parsed.blocks ?? []
    const valid = Array.isArray(blocks) && blocks.every((block) =>
      typeof block.content === 'string' && !/实践中|常用\s*8|必然|总是|一定会/.test(block.content))
    if (valid) console.log('[通过] 没把无出处经验数字和绝对化结论写进笔记')
    else { bad++; console.log('[有问题] 存疑内容被写进笔记：' + raw.slice(0, 500)) }
  } catch (err) {
    bad++
    console.log('[有问题] 经验数字用例返回无效结果：' + err.message)
  }

  console.log('─'.repeat(60))
  console.log('检查笔记入库核对提示词：前后说法冲突')
  try {
    const raw = account(await ask(apiKey, JSON.stringify({
      question: '推理时还需要遮罩吗？',
      assistantReply: '推理时也要加因果掩码。不遮的话，第 3 个位置会关注尚未生成的第 5 个位置。',
      previousNotes: ['推理时未来词尚未生成，本就不可见。'],
      candidateBlocks: [{ type: 'claim', content: '因果掩码在推理阶段同样要加：不遮时位置3会去关注尚未生成的位置5。' }]
    }), NOTE_VERIFY_PROMPT))
    const parsed = JSON.parse(raw)
    const valid = parsed.approved?.[0] === false && typeof parsed.reasons?.[0] === 'string' && parsed.reasons[0].trim()
    if (valid) console.log('[通过] 核对员拒绝与旧笔记冲突的新断言')
    else { bad++; console.log('[有问题] 核对员放行了冲突：' + raw.slice(0, 500)) }
  } catch (err) {
    bad++
    console.log('[有问题] 冲突用例返回无效结果：' + err.message)
  }
  }

  if (!REVIEW_ONLY && !PROFILE_ONLY) {
  console.log('─'.repeat(60))
  console.log('检查归航提示词：四层支线仍未走完')
  try {
    const raw = account(await ask(apiKey,
      '【支线 1】\nrootNodeId：root-four-level\n最初的问题：注意力机制为什么能知道该关注什么？\n路径：注意力机制 → 多头注意力 → softmax → 浮点数的二进制表示\n相关笔记：注意力机制会给不同位置不同权重；softmax 让权重归一化；浮点数的二进制表示还没解释。\n\n【本场最近对话】\n学习者：浮点数为什么不能精确表示 0.1？\n助手：这要看二进制小数怎样展开，今天还没讲到。',
      HOMEWARD_PROMPT))
    const row = JSON.parse(raw).threads?.[0]
    if (row?.rootNodeId === 'root-four-level' && row.isClosed === false &&
      typeof row.stoppedAt === 'string' && row.stoppedAt.trim() &&
      typeof row.nextStep === 'string' && /浮点|二进制|0\.1/.test(row.nextStep)) {
      console.log('[通过] 四层支线保留为未收线，并给出具体下一步')
    } else { bad++; console.log('[有问题] 把未解支线收线或下一步不具体：' + raw.slice(0, 500)) }
  } catch (err) {
    bad++
    console.log('[有问题] 归航返回无效结果：' + err.message)
  }
  }

  if (REVIEW_ONLY) {
    console.log('─'.repeat(60))
    console.log('检查复习出题提示词：必须是应用题')
    try {
      const raw = account(await ask(apiKey,
        '【知识点】softmax 数值稳定性\n【笔记】计算 softmax 时，先从所有输入减去最大值，避免指数溢出；分子分母同比例变化，结果不变。',
        REVIEW_QUESTION_PROMPT))
      const question = JSON.parse(raw).question
      const valid = typeof question === 'string' && question.length >= 8 && question.length <= 160 &&
        !/(是什么|什么是|请定义|请复述)/.test(question) && !/^\s*[-*•]\s/m.test(question)
      if (valid) console.log('[通过] ' + question)
      else { bad++; console.log('[有问题] 题目不符合应用题要求：' + raw.slice(0, 500)) }
    } catch (err) { bad++; console.log('[有问题] 出题失败：' + err.message) }

    console.log('─'.repeat(60))
    console.log('检查复习判题提示词：具体反馈和合理掌握度')
    try {
      const raw = account(await ask(apiKey,
        '【知识点】softmax 数值稳定性\n【笔记】计算 softmax 时，先从所有输入减去最大值，避免指数溢出；分子分母同比例变化，结果不变。\n【题目】一组输入都很大，直接计算 softmax 可能失败。怎么处理，为什么结果不变？\n【学习者回答】先从每个输入减去最大值，让指数不溢出；分子分母同比例变化，所以最终比例不变。',
        REVIEW_GRADE_PROMPT))
      const grade = JSON.parse(raw)
      const valid = grade.correct === true && Number.isInteger(grade.quality) && grade.quality >= 3 &&
        grade.quality <= 5 && Number.isInteger(grade.masteryDelta) && grade.masteryDelta >= 0 &&
        grade.masteryDelta <= 2 && typeof grade.feedback === 'string' && grade.feedback.length >= 3 &&
        grade.feedback.length <= 160 && !/^\s*[-*•]\s/m.test(grade.feedback)
      if (valid) console.log('[通过] ' + grade.feedback)
      else { bad++; console.log('[有问题] 判题不符合要求：' + raw.slice(0, 500)) }
    } catch (err) { bad++; console.log('[有问题] 判题失败：' + err.message) }
  }

  if (PROFILE_ONLY) {
    console.log('─'.repeat(60))
    console.log('检查行为画像只依据可观察信号')
    for (const [question, expected] of [
      ['第 1 轮：softmax 是什么？', 'basic_question'],
      ['第 1 轮：softmax 在数值很大时什么情况下会失效？', 'boundary_question']
    ]) {
      try {
        const raw = account(await ask(apiKey, question, PROFILE_SIGNAL_PROMPT))
        const signals = JSON.parse(raw).signals
        if (Array.isArray(signals) && signals.includes(expected)) console.log('[通过] ' + expected)
        else { bad++; console.log('[有问题] 没识别到 ' + expected + '：' + raw.slice(0, 500)) }
      } catch (err) { bad++; console.log('[有问题] 行为信号识别失败：' + err.message) }
    }
  }

  console.log('─'.repeat(60))
  console.log(`用量：输入 ${usage.prompt_tokens} token（缓存命中 ${usage.prompt_cache_hit_tokens}），输出 ${usage.completion_tokens} token`)
  const scope = PROFILE_ONLY ? '行为画像提示词 2 项' : REVIEW_ONLY ? '复习提示词 2 项' : HOMEWARD_ONLY ? '归航提示词 1 项' : `${QUESTIONS.length} 个对话问题，1 个领域入口，2 个笔记抽取，1 个入库核对，1 个归航`
  console.log(bad === 0 ? `全部通过（${scope}）` : `${bad} 项检查没通过`)
  app.exit(bad === 0 ? 0 : 1)
}).catch((err) => { console.error(err.message); app.exit(1) })
