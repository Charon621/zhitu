/**
 * 界面验证：真的把窗口打开，检查页面上渲染出了什么。
 *
 * 这一步是必要的 —— 前面的验证都在测"服务端能不能干活"，
 * 但用户看到的是界面。界面白屏的话，服务端全绿也没用。
 *
 * 它会在需要点击按钮时派发真实的鼠标事件（模拟用户操作），
 * 而不是直接调用组件内部函数，所以测的是真实路径。
 */

const { app, BrowserWindow, dialog, nativeTheme } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, existsSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

require(join(__dirname, '..', 'out', 'main', 'index.js'))

const results = []
let failed = 0
const consoleErrors = []
const shotsDir = process.env.ZHITU_SHOTS_DIR || join(tmpdir(), 'zhitu-shots')

async function saveShot(win, name) {
  await sleep(250)
  mkdirSync(shotsDir, { recursive: true })
  const image = await win.webContents.capturePage()
  writeFileSync(join(shotsDir, `${name}.png`), image.toPNG())
}

app.on('browser-window-created', (_event, win) => {
  // 页面加载前就挂上监听，才能抓到早期的报错
  win.webContents.on('console-message', (event) => {
    // Electron 38 起改成了对象参数
    const level = typeof event === 'object' && event !== null ? event.level : arguments[1]
    const message = typeof event === 'object' && event !== null ? event.message : arguments[2]
    if (level === 'error' || level === 3) consoleErrors.push(String(message))
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    consoleErrors.push(`渲染进程崩溃: ${details?.reason}`)
  })
})

function check(name, condition, detail = '') {
  results.push({ ok: !!condition, name, detail })
  if (!condition) failed++
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 在页面里执行一段代码，把结果拿回来 */
async function evaluate(win, code) {
  return await win.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
}

async function waitForCondition(win, code, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(win, code)
    if (value) return value
    await sleep(120)
  }
  return null
}

/** 像真人一样点某个按钮：派发 pointer / mouse 事件 */
function clickHelper(selectorText) {
  return `
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => (b.textContent || '').trim().includes(${JSON.stringify(selectorText)}));
    if (!btn) return false;
    const r = btn.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    btn.dispatchEvent(new PointerEvent('pointerdown', opts));
    btn.dispatchEvent(new MouseEvent('mousedown', opts));
    btn.dispatchEvent(new PointerEvent('pointerup', opts));
    btn.dispatchEvent(new MouseEvent('mouseup', opts));
    btn.dispatchEvent(new MouseEvent('click', opts));
    return true;
  `
}

function fillHelper(selector, value) {
  return `
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `
}

app.whenReady().then(async () => {
  const report = []
  let mock = null
  try {
    const win = await new Promise((resolve) => {
      const existing = BrowserWindow.getAllWindows()[0]
      if (existing) return resolve(existing)
      app.on('browser-window-created', (_e, w) => resolve(w))
    })

    if (win.webContents.isLoading()) {
      await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
    }
    await waitForCondition(win, `return !!document.querySelector('.onboard-card') || !!document.querySelector('.shell')`)
    await sleep(500)
    win.setSize(1280, 840)
    await sleep(300)
    await saveShot(win, '01-首次向导-选服务商')

    // ── 1. 非白屏 ──
    const bodyText = await evaluate(win, `return (document.body.innerText || '').slice(0, 400)`)
    const bodyLen = await evaluate(win, `return (document.body.innerText || '').length`)
    check('页面不是白屏', bodyLen > 40, `正文 ${bodyLen} 字`)
    check('没有错误提示', !bodyText.includes('没能启动'), bodyText.slice(0, 80))

    const hasOnboard = await evaluate(win, `return !!document.querySelector('.onboard-card')`)
    check('首次打开显示的是向导', hasOnboard)

    // ── 2. 向导第一步 ──
    check('标题是"织图"', bodyText.includes('织图'))
    check('向导只有两步', await evaluate(win, `return document.querySelectorAll('.steps .step').length === 2`))
    check('向导不再询问水平', !bodyText.includes('你的水平'))

    const providers = await evaluate(win, `return document.querySelectorAll('.provider-list .provider-item').length`)
    check('列出了 6 个服务商', providers === 6, `实际 ${providers} 个`)
    check('默认选中第一个（DeepSeek）', await evaluate(win, `return !!document.querySelector('.provider-item.selected')`))
    check('显示了服务商说明', bodyText.includes('便宜、中文好'))

    mock = await require('./mock-provider.cjs').startMockProvider()
    check('能选择自定义服务商', await evaluate(win, `
      const radio = Array.from(document.querySelectorAll('input[name=provider]')).at(-1);
      if (!radio) return false; radio.click(); return radio.checked;
    `))

    // 点一下"下一步"
    check('能找到"下一步"按钮', await evaluate(win, clickHelper('下一步')))
    await waitForCondition(win, `return document.body.innerText.includes('粘贴你的密钥')`)
    check('进入了第 2 步', await evaluate(win, `return document.body.innerText.includes('粘贴你的密钥')`))

    // ── 3. 第二步的细节 ──
    check('有密钥输入框（类型为密码）', await evaluate(win, `return document.querySelector('input[type=password]') !== null`))
    check('说明密钥会发送给所选服务商', await evaluate(win, `return document.body.innerText.includes('选的服务商')`))
    check(
      '没填密钥时"开始使用"不可点',
      await evaluate(
        win,
        `const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('开始使用')); return !!b && b.disabled === true;`
      )
    )
    check(
      '没填密钥时"测试连接"不可点',
      await evaluate(
        win,
        `const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('测试连接')); return !!b && b.disabled === true;`
      )
    )

    // ── 4. 完整走过两步向导，检查首次主界面 ──
    check('能填自定义接口地址', await evaluate(win, fillHelper('input[placeholder="https://你的服务商/v1"]', mock.baseURL)))
    check('能填模型名', await evaluate(win, fillHelper('input[placeholder="比如 deepseek-chat"]', 'mock-model')))
    check('能填密钥', await evaluate(win, fillHelper('input[type=password]', 'sk-mock-123')))
    check('能点测试连接', await evaluate(win, clickHelper('测试连接')))
    check('真实界面收到连接成功', !!(await waitForCondition(win, `return document.body.innerText.includes('连接成功')`)))
    await saveShot(win, '02-首次向导-填密钥并测试')
    check('第二步直接提供开始使用', await evaluate(win, clickHelper('开始使用')))
    check('完成向导后显示开始卡片', !!(await waitForCondition(win, `return !!document.querySelector('.start-card')`)))
    await saveShot(win, '03-开始卡片')
    check('开始卡片有领域入口和三个示例', await evaluate(win, `return !!document.querySelector('#start-domain') && document.querySelectorAll('.start-example').length === 3`))
    check('开始卡片有真实可点的资料导入入口', await evaluate(win,
      `return document.querySelector('.start-files')?.tagName === 'BUTTON' && !!document.querySelector('input[type=file]')`))
    check('开始卡片下没有空白输入框', await evaluate(win, `return !document.querySelector('.composer textarea')`))
    check('自己提问入口能打开输入框', await evaluate(win, clickHelper('我有具体问题')) &&
      !!(await waitForCondition(win, `return !!document.querySelector('.composer textarea')`)))
    check('新的一场能重新打开开始卡片', await evaluate(win, clickHelper('新的一场')) &&
      !!(await waitForCondition(win, `return !!document.querySelector('.start-card')`)))

    // ── 5. 示例问题一次点击就发出第一轮 ──
    check('示例问题可以点击', await evaluate(win, clickHelper('神经网络到底')))
    check('示例问题直接变成用户第一句话', !!(await waitForCondition(win, `return document.querySelector('.msg.user')?.innerText.includes('神经网络到底')`)))
    check('示例问答收到模型回复', !!(await waitForCondition(win, `return document.querySelector('.msg.assistant')?.innerText.includes('减去最大值')`)))
    check('对话开始后不再显示开始卡片', await evaluate(win, `return !document.querySelector('.start-card')`))
    check('助手回复后右栏出现笔记卡片', !!(await waitForCondition(win,
      `return document.querySelector('.note-card')?.innerText.includes('最大项变成 1')`, 8000)))
    check('笔记卡片自然展开且没有内部滚动陷阱', await evaluate(win, `const card = document.querySelector('.note-card'); return card && card.scrollHeight <= card.clientHeight + 1`))
    check('笔记卡片显示类型和原文入口', await evaluate(win,
      `return document.querySelector('.note-card')?.innerText.includes('核心') && document.querySelector('.note-card')?.innerText.includes('看原文')`))
    await saveShot(win, '06-实时笔记卡片')

    // ── 5.1 笔记页节点树和完整卡片 ──
    const noteDb = globalThis.__zhitu.db.db
    const noteNode = noteDb.prepare('SELECT id FROM nodes WHERE kind != ? ORDER BY rowid DESC LIMIT 1').get('resource')
    const noteTurn = noteDb.prepare('SELECT origin_turn_id FROM note_blocks WHERE node_id = ? LIMIT 1').get(noteNode.id)
    const noteNow = new Date().toISOString()
    for (let index = 0; index < 3; index++) noteDb.prepare(`INSERT INTO note_blocks
      (id, node_id, block_type, content_md, ordinal, origin_turn_id, created_at, updated_at)
      VALUES (?, ?, 'claim', ?, ?, ?, ?, ?)`).run(`blk-ui-extra-${index}`, noteNode.id,
        `这条补充笔记用于验证完整卡片 ${index + 1}`, index + 2, noteTurn.origin_turn_id, noteNow, noteNow)
    check('左栏可打开笔记页', await evaluate(win, clickHelper('笔记')) &&
      !!(await waitForCondition(win, `return !!document.querySelector('.notes-page')`)))
    const expectedCards = noteDb.prepare('SELECT COUNT(DISTINCT node_id) AS n FROM note_blocks WHERE deleted_by_user = 0').get().n
    check('笔记页卡片数与数据库一致', !!(await waitForCondition(win,
      `return document.querySelector('.notes-page-head span')?.innerText === ${JSON.stringify(`${expectedCards} 张卡片`)}`)))
    check('笔记页左侧是可点击节点树', !!(await waitForCondition(win,
      `return !!document.querySelector('.notes-tree .note-tree-title') && !!document.querySelector('.notes-detail .note-card')`)))
    check('笔记节点树说明了大纲跳转', await evaluate(win,
      `return document.querySelector('.notes-outline-label')?.innerText.includes('点标题跳到知识点')`))
    check('完整卡片显示右栏折叠掉的笔记块', !!(await waitForCondition(win,
      `return document.querySelectorAll('.notes-detail .note-block').length === 4`)))
    await saveShot(win, '07-笔记页')
    noteDb.prepare(`INSERT INTO nodes (id, topic_id, title, kind, status, created_at, updated_at, last_seen_at)
      SELECT ?, topic_id, 'softmax 的后续问题', 'question', 'gathered', ?, ?, ? FROM nodes WHERE id = ?`)
      .run('nod-ui-child', noteNow, noteNow, noteNow, noteNode.id)
    noteDb.prepare(`INSERT INTO note_blocks
      (id, node_id, block_type, content_md, ordinal, origin_turn_id, created_at, updated_at)
      VALUES (?, ?, 'claim', '继续理解 softmax', 1, ?, ?, ?)`)
      .run('blk-ui-child', 'nod-ui-child', noteTurn.origin_turn_id, noteNow, noteNow)
    noteDb.prepare("INSERT INTO edges (id, src_id, dst_id, type, created_at) VALUES (?, ?, ?, 'parent', ?)")
      .run('edg-ui-child', noteNode.id, 'nod-ui-child', noteNow)
    await evaluate(win, clickHelper('对话'))
    await evaluate(win, clickHelper('笔记'))
    check('节点树按 parent 连线缩进子节点', !!(await waitForCondition(win,
      `const rows = Array.from(document.querySelectorAll('.note-tree-row'));
       return rows.length === 2 && rows[1].innerText.includes('softmax 的后续问题') &&
         parseInt(rows[1].style.paddingLeft) > parseInt(rows[0].style.paddingLeft);`)))
    const collapseClicked = await evaluate(win,
      `const btn = document.querySelector('.note-tree-toggle'); if (!btn) return false; btn.click(); return true;`)
    check('节点树可以折叠支线', collapseClicked && !!(await waitForCondition(win,
      `return document.querySelectorAll('.note-tree-row').length === 1`)))
    const filterClicked = await evaluate(win,
      `const box = document.querySelector('.notes-open-filter input'); if (!box) return false; box.click(); return true;`)
    check('只看未收线筛选正确更新卡片数', filterClicked && !!(await waitForCondition(win,
      `return document.querySelector('.notes-page-head span')?.innerText === '1 张卡片'`)))
    check('笔记页重讲入口回到原场并带上问题', await evaluate(win, clickHelper('让 AI 重讲')) &&
      !!(await waitForCondition(win,
        `return !!document.querySelector('.msg.user') && document.querySelector('.textarea')?.value.includes('请换一个角度重讲')`)))

    // ── 5.2 地图：50 个节点时仍可看、可操作 ──
    const mapTopicId = noteDb.prepare('SELECT topic_id FROM nodes WHERE id = ?').get(noteNode.id).topic_id
    // 造一个"只有资料、没有任何知识点"的主题(比如刚导入还没聊过的文件)。
    // 它是最新创建的主题,旧逻辑会被它抢走默认选中,地图打开一片空白。
    noteDb.prepare(`INSERT INTO topics (id, title, goal_kind, created_at) VALUES ('top-ui-empty-topic', '空的资料主题', 'casual', ?)`)
      .run(new Date().toISOString())
    let parentId = 'nod-ui-child'
    for (let index = 0; index < 48; index++) {
      const id = `nod-ui-map-${index}`
      noteDb.prepare(`INSERT INTO nodes (id, topic_id, title, kind, status, created_at, updated_at, last_seen_at)
        VALUES (?, ?, ?, 'question', 'gathered', ?, ?, ?)`).run(id, mapTopicId, `延伸问题 ${index + 1}`, noteNow, noteNow, noteNow)
      noteDb.prepare("INSERT INTO edges (id, src_id, dst_id, type, created_at) VALUES (?, ?, ?, 'parent', ?)")
        .run(`edg-ui-map-${index}`, parentId, id, noteNow)
      parentId = id
    }
    check('左栏可打开地图页', await evaluate(win, clickHelper('地图')) &&
      !!(await waitForCondition(win, `return !!document.querySelector('.map-page')`)))
    check('地图默认选中有知识点的主题(空主题不进下拉)', !!(await waitForCondition(win,
      `const sel = document.querySelector('select[aria-label="选择地图主题"]')
       return !!sel && sel.selectedOptions[0]?.textContent !== '空的资料主题' &&
         ![...sel.options].some((option) => option.textContent === '空的资料主题')`, 10000)))
    check('地图初始只展开两层', !!(await waitForCondition(win,
      `return document.querySelector('.map-toolbar span')?.innerText === '2 / 50 个点' &&
        document.querySelector('.map-canvas')?.getAttribute('data-render-nodes') === '2'`, 10000)))
    check('地图图例常驻可见', await evaluate(win,
      `return !!document.querySelector('.map-legend') && getComputedStyle(document.querySelector('.map-legend')).display !== 'none'`))
    await saveShot(win, '08-地图初始两层')
    const mapStarted = Date.now()
    check('五十个节点可切到全览', await evaluate(win, clickHelper('全览')) &&
      !!(await waitForCondition(win,
        `return document.querySelector('.map-toolbar span')?.innerText === '50 / 50 个点' &&
          document.querySelector('.map-canvas')?.getAttribute('data-render-nodes') === '50'`, 10000)))
    const renderTime = await waitForCondition(win,
      `return Number(document.querySelector('.map-canvas')?.getAttribute('data-render-ms')) || null`, 10000)
    check('五十节点渲染在两秒内完成', typeof renderTime === 'number' && renderTime < 2000,
      `performance.now() 约 ${renderTime} ms；切换含异步状态 ${Date.now() - mapStarted} ms`)
    await saveShot(win, '09-地图五十节点')

    // ── 5.3 复习：真实界面出题、作答与反馈 ──
    noteDb.prepare('UPDATE reviews SET due_at = ? WHERE node_id = ?')
      .run(new Date(Date.now() - 86_400_000).toISOString(), noteNode.id)
    check('左栏可打开复习页', await evaluate(win, clickHelper('复习')) &&
      !!(await waitForCondition(win, `return !!document.querySelector('.review-page')`)))
    check('复习页显示到期数量与开始入口', !!(await waitForCondition(win,
      `return document.querySelector('.review-card')?.innerText.includes('到了复习时间') &&
        document.querySelector('.review-card')?.innerText.includes('开始复习')`)))
    check('复习生成应用题而非背诵题', await evaluate(win, clickHelper('开始复习')) &&
      !!(await waitForCondition(win, `return document.querySelector('.review-card h2')?.innerText.includes('特别大')`, 10000)))
    const filledReview = await evaluate(win, `
      const input = document.querySelector('.review-card textarea'); if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, '先减去最大值，这样指数不会溢出，分子分母的比例也不变。');
      input.dispatchEvent(new Event('input', { bubbles: true })); return true;`)
    check('复习回答可提交并显示具体反馈', filledReview && await evaluate(win, clickHelper('提交回答')) &&
      !!(await waitForCondition(win,
        `return document.querySelector('.review-feedback')?.innerText.includes('指数溢出')`, 10000)))
    check('复习后掌握度和下一次日期更新', noteDb.prepare('SELECT last_reviewed_at FROM reviews WHERE node_id = ?')
      .get(noteNode.id)?.last_reviewed_at &&
      noteDb.prepare('SELECT mastery FROM nodes WHERE id = ?').get(noteNode.id)?.mastery > 0)
    await saveShot(win, '10-复习反馈')

    // ── 5.4 全局搜索与导出弹窗 ──
    check('左栏可以打开全局搜索', await evaluate(win, clickHelper('搜索')) &&
      !!(await waitForCondition(win, `return !!document.querySelector('.search-modal .search-input')`)))
    check('搜索面板有三个快速操作', await evaluate(win,
      `return ['新的一场', '打开设置', '导出'].every(t => document.querySelector('.search-results')?.innerText.includes(t))`))
    check('搜索结果能定位到知识点', await evaluate(win, fillHelper('.search-input', 'softmax')) &&
      !!(await waitForCondition(win,
        `return Array.from(document.querySelectorAll('.search-results button')).some(b => b.innerText.includes('知识点'))`, 10000)))
    await saveShot(win, '11-全局搜索')
    check('搜索结果打开指定笔记而非默认第一张', await evaluate(win, `
      const btn = Array.from(document.querySelectorAll('.search-results button'))
        .find(b => b.innerText.includes('知识点') && b.innerText.includes('softmax 的后续问题')); if (!btn) return false; btn.click(); return true;`) &&
      !!(await waitForCondition(win, `return document.querySelector('.notes-detail .note-card')?.dataset.noteId === 'nod-ui-child'`)))
    check('左栏可打开导出入口', await evaluate(win, clickHelper('导出')) &&
      !!(await waitForCondition(win, `return !!document.querySelector('.export-modal')`)))
    check('导出显示笔记、单场对话、全部数据三种文件', await evaluate(win,
      `return document.querySelectorAll('.export-options > button').length === 3 &&
        ['全部笔记', '本场对话', '全部数据备份'].every(t => document.querySelector('.export-options')?.innerText.includes(t))`))
    await saveShot(win, '12-导出')
    const savedZipPath = join(shotsDir, '界面实际保存-全部笔记.zip')
    const originalSaveDialog = dialog.showSaveDialog
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: savedZipPath })
    check('界面点击导出能调用保存窗口', await evaluate(win, clickHelper('全部笔记')) &&
      !!(await waitForCondition(win, `return document.querySelector('.export-modal [role=status]')?.innerText.includes('文件已保存')`, 10000)))
    dialog.showSaveDialog = originalSaveDialog
    const savedZip = existsSync(savedZipPath)
      ? await require('jszip').loadAsync(readFileSync(savedZipPath)) : null
    check('用户选定位置后真正写出可读压缩包', savedZip &&
      Object.keys(savedZip.files).some((path) => path.endsWith('.md') && path !== '导出说明.md'))
    await evaluate(win, `document.querySelector('.export-modal .modal-head button')?.click()`)

    // ── 6. 新的一场，领域选择到三个起点再发出第一轮 ──
    check('新的一场可以重新看到开始卡片', await evaluate(win, clickHelper('新的一场')) &&
      !!(await waitForCondition(win, `return !!document.querySelector('.start-card')`)))
    check('可以输入领域名', await evaluate(win, fillHelper('#start-domain', 'AI')))
    check('进入学习倾向中间页', await evaluate(win, clickHelper('开始')) &&
      !!(await waitForCondition(win, `return !!document.querySelector('.start-tendencies')`)))
    await saveShot(win, '04-学习倾向')
    check('中间页说明倾向不锁定', await evaluate(win, `return document.body.innerText.includes('这不锁定什么，随时可以改')`))
    check('可以选择偏动手', await evaluate(win, `const r = document.querySelector('input[value=hands_on]'); if (!r) return false; r.click(); return r.checked;`))
    check('能请求生成三个起点', await evaluate(win, clickHelper('帮我挑三个起点')))
    check('三个起点及理由显示出来', !!(await waitForCondition(win, `return document.querySelectorAll('.start-entry').length === 3 && document.querySelectorAll('.start-entry small').length === 3`)))
    await saveShot(win, '05-三个起点')
    check('点起点立即发送，不要求再打字', await evaluate(win, clickHelper('AI 为什么能认出一张猫的照片')) &&
      !!(await waitForCondition(win, `return document.querySelector('.msg.user')?.innerText.includes('AI 为什么能认出')`)))
    check('领域问答收到模型回复', !!(await waitForCondition(win, `return document.querySelector('.msg.assistant')?.innerText.includes('减去最大值')`)))
    const domainSession = globalThis.__zhitu.db.db.prepare(
      'SELECT topics.title, topics.goal_kind FROM topics JOIN sessions ON sessions.topic_id = topics.id ORDER BY sessions.started_at DESC LIMIT 1'
    ).get()
    check('领域名与偏好落进主题', domainSession?.title === 'AI' && domainSession?.goal_kind === 'hands_on')
    const reloaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
    win.webContents.reload()
    await reloaded
    check('重开页面找回刚才的对话', !!(await waitForCondition(win, `return document.querySelector('.msg.user')?.innerText.includes('AI 为什么能认出')`)))
    check('重开已有对话不重复显示开始卡片', await evaluate(win, `return !document.querySelector('.start-card')`))

    // ── 7. 设置弹窗依然能用 ──
    check('能找到设置按钮', await evaluate(win, clickHelper('设置')))
    await waitForCondition(win, `return !!document.querySelector('.modal')`)
    check('设置弹窗能打开', await evaluate(win, `return !!document.querySelector('.modal')`))
    const modalText = await evaluate(win, `return (document.querySelector('.modal')?.innerText || '')`)
    await saveShot(win, '08-设置弹窗')
    check('弹窗里有服务商选项', modalText.includes('服务商'))
    check('弹窗里有 API Key 字段', modalText.includes('API Key'))
    check('弹窗里有后台整理模型配置', modalText.includes('后台整理模型'))
    check('弹窗里有默认关闭的视觉识别开关', modalText.includes('视觉识别') &&
      await evaluate(win, `return document.querySelector('input[type=checkbox]')?.checked === false`))
    check('弹窗里有重算本场笔记入口', modalText.includes('重算') && modalText.includes('本场笔记'))
    check('弹窗显示了数据目录', modalText.includes('数据目录'))
    await evaluate(win, clickHelper('关闭'))
    await sleep(300)
    check('弹窗能关掉', await evaluate(win, `return !document.querySelector('.modal')`))

    // ── 8. 从空白场次直接导入资料并自动开始提问 ──
    await evaluate(win, clickHelper('新的一场'))
    const fileChanged = await evaluate(win, `
      const input = document.querySelector('input[type=file]');
      if (!input) return false;
      const transfer = new DataTransfer();
      transfer.items.add(new File(['# 注意力机制\\nATTACHMENT_UI_ANCHOR 是本样本的关键字段。'], '课堂笔记.md', { type: 'text/markdown' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `)
    check('文件选择框可把资料送入界面', fileChanged &&
      !!(await waitForCondition(win, `return document.querySelector('.attachment-chip')?.innerText.includes('课堂笔记.md')`)))
    check('导入资料后自动发起第一问', !!(await waitForCondition(win,
      `return document.querySelector('.msg.user')?.innerText.includes('这份资料讲了什么')`, 10000)))
    check('第一问带上资料小卡片', await evaluate(win,
      `return document.querySelector('.msg.user .message-attachment')?.innerText.includes('课堂笔记.md')`))
    check('资料问答收到模型回复', !!(await waitForCondition(win,
      `return document.querySelector('.msg.assistant')?.innerText.includes('减去最大值')`, 10000)))
    check('资料相关切片真的进入模型上下文', mock.requests.some((request) =>
      request.stream === true && request.messages?.[0]?.content?.includes('ATTACHMENT_UI_ANCHOR')))
    await saveShot(win, '08-导入资料后提问')
    check('资料 chip 显示就绪且可移出本次提问', await evaluate(win,
      `return document.querySelector('.attachment-chip')?.innerText.includes('就绪') && !!document.querySelector('.attachment-chip button[title="从本次提问移除"]')`))
    await evaluate(win, clickHelper('课堂笔记.md'))
    check('文本资料可打开原文预览', !!(await waitForCondition(win,
      `return document.querySelector('.document-preview')?.innerText.includes('ATTACHMENT_UI_ANCHOR')`)))
    await saveShot(win, '09-资料预览')
    await evaluate(win, clickHelper('关闭'))

    // ── 9. 归航卡片与未收线真实呈现 ──
    const uiDb = globalThis.__zhitu.db.db
    const uiSession = uiDb.prepare('SELECT id, topic_id FROM sessions ORDER BY started_at DESC LIMIT 1').get()
    const uiNow = new Date().toISOString()
    // 节点在真实流程里都来自本场某一轮对话：补上这一轮并写进 origin_turn_id，
    // 否则它不属于任何场次，归航不会把它算作本场的支线。
    uiDb.prepare("INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)")
      .run('trn-ui-homeward', uiSession.id, '注意力机制到底是怎么算的？', uiNow)
    uiDb.prepare(`INSERT INTO nodes (id, topic_id, title, kind, status, origin_turn_id, created_at, updated_at, last_seen_at)
      VALUES (?, ?, '注意力机制', 'question', 'open', ?, ?, ?, ?)`)
      .run('nod-ui-homeward', uiSession.topic_id, 'trn-ui-homeward', uiNow, uiNow, uiNow)
    check('今天到这儿按钮可点击', await evaluate(win, clickHelper('今天到这儿')))
    check('本场小结在对话末尾可见', !!(await waitForCondition(win,
      `return document.querySelector('[data-testid="homeward-summary"]')?.innerText.includes('本场收起')`, 30000)))
    check('右栏显示未收线下一步与三种出路', !!(await waitForCondition(win,
      `const card = Array.from(document.querySelectorAll('.unfinished-card')).find(c => c.innerText.includes('注意力机制'));
       return card && card.innerText.includes('从浮点数的二进制表示继续') &&
         ['继续', '我懂了', '不感兴趣'].every(label => card.innerText.includes(label));`, 10000)))
    await saveShot(win, '10-归航与未收线')

    // ── 9.1 最近场次、未收线主页面与快捷键 ──
    check('左栏列出最近场次并能回看', !!(await waitForCondition(win,
      `return document.querySelectorAll('.recent-session').length >= 3 &&
        Array.from(document.querySelectorAll('.recent-session')).some(b => b.innerText.includes('课堂笔记'))`, 10000)))
    await evaluate(win, `Array.from(document.querySelectorAll('.recent-session'))
      .find(b => b.innerText.includes('神经网络到底'))?.click()`)
    check('点击较早场次能找回原对话', !!(await waitForCondition(win,
      `return document.querySelector('.main-title')?.innerText.includes('神经网络到底') &&
        document.querySelector('.msg.user')?.innerText.includes('神经网络到底')`)))
    await evaluate(win, `Array.from(document.querySelectorAll('.recent-session'))
      .find(b => b.innerText.includes('课堂笔记'))?.click()`)
    check('点击最近场次能重新切回来', !!(await waitForCondition(win,
      `return document.querySelector('.main-title')?.innerText.includes('课堂笔记') &&
        document.querySelector('.msg.user')?.innerText.includes('这份资料讲了什么')`)))
    check('左栏未收线入口带数量', await evaluate(win,
      `return Array.from(document.querySelectorAll('.main-nav button')).some(b => /未收线（[1-9]/.test(b.innerText))`))
    check('未收线有独立主页面', await evaluate(win, clickHelper('未收线（')) &&
      !!(await waitForCondition(win, `return !!document.querySelector('.unfinished-page .unfinished-card')`)))
    await saveShot(win, '13-未收线主页面')
    check('从未收线主页面可带着下一步回对话', await evaluate(win,
      `document.querySelector('.unfinished-page .unfinished-card button')?.click(); return true;`) &&
      !!(await waitForCondition(win,
        `return !!document.querySelector('.composer textarea') && document.querySelector('.composer textarea').value.includes('浮点数')`)))
    check('本周回顾页面显示真实学习数量和未收线问题', await evaluate(win, clickHelper('本周回顾')) &&
      !!(await waitForCondition(win, `return document.querySelector('.stats-page .stats-numbers')?.innerText.includes('场学习') &&
        document.querySelector('.stats-page')?.innerText.includes('softmax')`)))
    check('本周回顾可带着未收线问题返回对话', await evaluate(win,
      `document.querySelector('.stats-page .stats-list button')?.click(); return true;`) &&
      !!(await waitForCondition(win,
        `return !!document.querySelector('.composer textarea') && document.querySelector('.composer textarea').value.includes('浮点数')`)))
    await evaluate(win, clickHelper('本周回顾'))
    await saveShot(win, '17-本周回顾')
    await evaluate(win, clickHelper('对话'))
    check('专注阅读隐藏两侧栏', await evaluate(win, clickHelper('专注阅读')) &&
      !!(await waitForCondition(win,
        `return getComputedStyle(document.querySelector('.sidebar')).display === 'none' &&
          getComputedStyle(document.querySelector('.rightbar')).display === 'none' &&
          !!document.querySelector('.shell.focus-mode')`)))
    await saveShot(win, '16-专注模式')
    check('退出专注恢复两侧栏', await evaluate(win, clickHelper('退出专注')) &&
      !!(await waitForCondition(win,
        `return getComputedStyle(document.querySelector('.sidebar')).display !== 'none' &&
          getComputedStyle(document.querySelector('.rightbar')).display !== 'none'`)))
    check('Ctrl+K 打开搜索并可用 Esc 关闭', await evaluate(win,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
       return !!document.querySelector('.search-modal');`) ||
      !!(await waitForCondition(win, `return !!document.querySelector('.search-modal')`)))
    await evaluate(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    check('Esc 关闭搜索', !!(await waitForCondition(win, `return !document.querySelector('.search-modal')`)))
    await evaluate(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }))`)
    check('Ctrl+/ 打开快捷键列表', !!(await waitForCondition(win,
      `return document.querySelector('.shortcuts-modal')?.innerText.includes('Ctrl+Enter')`)))
    await evaluate(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

    // ── 9.2 深色模式随系统切换，截图核对 ──
    nativeTheme.themeSource = 'dark'
    check('系统深色模式自动换成深色背景', !!(await waitForCondition(win,
      `return getComputedStyle(document.body).backgroundColor === 'rgb(28, 27, 25)'`)))
    check('深色正文与背景对比度达到 4.5', await evaluate(win, `
      const body = getComputedStyle(document.body);
      const rgb = s => (s.match(/\\d+/g) || []).slice(0, 3).map(Number);
      const lum = a => a.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 })
        .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      const x = lum(rgb(body.color)), y = lum(rgb(body.backgroundColor));
      return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) >= 4.5;`))
    check('深色主按钮文字对比度达到 4.5', await evaluate(win, `
      const style = getComputedStyle(document.querySelector('.sidebar .btn.primary'));
      const lum = s => (s.match(/\\d+/g) || []).slice(0,3).map(Number).map(v => {v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4}).reduce((sum,v,i) => sum + v * [.2126,.7152,.0722][i],0);
      const a = lum(style.color), b = lum(style.backgroundColor); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05) >= 4.5;`))
    await saveShot(win, '14-深色模式')
    await evaluate(win, clickHelper('地图'))
    await waitForCondition(win, `return document.querySelector('.map-canvas')?.dataset.renderMs !== ''`)
    await saveShot(win, '14-深色地图')
    await evaluate(win, clickHelper('对话'))
    nativeTheme.themeSource = 'light'

    // ── 9.3 API 密钥失效时保留顶部提醒，重测成功才消失 ──
    const port = globalThis.__zhitu.port
    const token = globalThis.__zhitu.token
    const setKey = (value) => fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zhitu-Token': token },
      body: JSON.stringify({ apiKey: value })
    })
    await setKey('sk-expired')
    await evaluate(win, clickHelper('新的一场'))
    await evaluate(win, clickHelper('我有具体问题'))
    await evaluate(win, `const el = document.querySelector('.composer textarea');
      if (el) { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(el, '测试密钥提醒'); el.dispatchEvent(new Event('input', { bubbles: true })); }`)
    await evaluate(win, `document.querySelector('.composer textarea')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true }))`)
    check('Ctrl+Enter 即使同时按着 Shift 也会强制发送', !!(await waitForCondition(win,
      `return !!document.querySelector('.msg.user')?.innerText.includes('测试密钥提醒')`, 10000)))
    check('密钥 401 时顶部显示常驻提醒', !!(await waitForCondition(win,
      `return document.querySelector('.key-warning')?.innerText.includes('密钥可能已失效')`, 10000)))
    await saveShot(win, '15-密钥失效提醒')
    await setKey('sk-mock-123')
    await evaluate(win, clickHelper('设置'))
    await waitForCondition(win, `return !!document.querySelector('.modal-body')`)
    await evaluate(win, clickHelper('测试连接'))
    check('测试连接成功后密钥提醒消失', !!(await waitForCondition(win,
      `return !document.querySelector('.key-warning') && document.querySelector('.test-result.ok')`, 10000)))
    await evaluate(win, `document.querySelector('.modal-head button')?.click()`)

    // ── New workspace regressions ──
    check('历史学习入口可打开并筛选', await evaluate(win, clickHelper('学习记录')) &&
      !!(await waitForCondition(win, `return !!document.querySelector('.history-modal .search-input')`)))
    await evaluate(win, fillHelper('.history-modal input', '不存在的学习标题'))
    check('历史筛选提供空状态', !!(await waitForCondition(win, `return document.querySelector('.history-modal')?.innerText.includes('没有匹配')`)))
    await evaluate(win, fillHelper('.history-modal input', ''))
    await waitForCondition(win, `return document.querySelectorAll('.history-modal .history-row').length > 1`)
    await saveShot(win, '20-学习记录管理')

    // ── 历史记录管理：改名 / 归档 / 删除 ──
    const historyRows = await evaluate(win, `return document.querySelectorAll('.history-modal .history-row').length`)
    check('历史记录每行都有管理入口', historyRows > 1 && await evaluate(win,
      `const row = document.querySelector('.history-modal .history-row');
       return ['改名', '归档', '删除'].every(t => row.innerText.includes(t))`))

    const renameTarget = await evaluate(win,
      `return document.querySelectorAll('.history-modal .history-row')[1]?.querySelector('.history-open strong')?.innerText`)
    check('历史记录可改名并写回数据库', !!renameTarget && await evaluate(win,
      `Array.from(document.querySelectorAll('.history-modal .history-row'))[1].querySelector('.history-actions button').click(); return true`) &&
      !!(await waitForCondition(win, `return !!document.querySelector('.history-modal .history-rename')`)) &&
      await evaluate(win, fillHelper('.history-modal .history-rename', '改过名的学习记录')) &&
      await evaluate(win, `Array.from(document.querySelectorAll('.history-modal button')).find(b => b.textContent.trim() === '保存').click(); return true`) &&
      !!(await waitForCondition(win, `return document.querySelector('.history-modal')?.innerText.includes('改过名的学习记录')`)) &&
      uiDb.prepare('SELECT COUNT(*) AS n FROM sessions WHERE title = ?').get('改过名的学习记录').n === 1)

    check('归档会把场次收起来且数据仍在', await evaluate(win,
      `const row = Array.from(document.querySelectorAll('.history-modal .history-row'))
         .find(r => r.innerText.includes('改过名的学习记录'));
       Array.from(row.querySelectorAll('.history-actions button')).find(b => b.textContent.trim() === '归档').click();
       return true`) &&
      !!(await waitForCondition(win, `return !document.querySelector('.history-modal')?.innerText.includes('改过名的学习记录')`)) &&
      uiDb.prepare("SELECT archived_at FROM sessions WHERE title = '改过名的学习记录'").get().archived_at &&
      uiDb.prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = (SELECT id FROM sessions WHERE title = ?)')
        .get('改过名的学习记录').n > 0 &&
      !!(await waitForCondition(win,
        `return document.querySelector('.history-modal')?.innerText.includes('已归档（1）')`)))

    check('已归档的场次可以恢复', await evaluate(win,
      `Array.from(document.querySelectorAll('.history-modal button')).find(b => b.textContent.includes('已归档（')).click(); return true`) &&
      !!(await waitForCondition(win, `return !!document.querySelector('.history-modal .history-row.archived')`)) &&
      await evaluate(win,
        `const row = document.querySelector('.history-modal .history-row.archived');
         Array.from(row.querySelectorAll('.history-actions button')).find(b => b.textContent.trim() === '恢复').click();
         return true`) &&
      !!(await waitForCondition(win, `return !document.querySelector('.history-modal .history-row.archived')`)) &&
      uiDb.prepare("SELECT archived_at FROM sessions WHERE title = '改过名的学习记录'").get().archived_at === null)

    // 删除按钮必须真的会删除，所以它得长得像"危险动作"，不能跟普通按钮一样。
    check('删除入口是危险样式', await evaluate(win,
      `const btns = Array.from(document.querySelectorAll('.history-modal .history-row .history-actions button'))
         .filter(b => b.textContent.trim() === '删除');
       return btns.length > 0 && btns.every(b => b.classList.contains('danger'))`))

    // ── 两级删除：常态是移入回收站（可恢复 + 撤销条），彻底删除才要二次确认 ──
    const deleteTarget = await evaluate(win,
      `const rows = Array.from(document.querySelectorAll('.history-modal .history-row'));
       const row = rows[rows.length - 1];
       const title = row.querySelector('.history-open strong').innerText;
       Array.from(row.querySelectorAll('.history-actions button')).find(b => b.textContent.trim() === '删除').click();
       return title`)
    check('删除前先给出删什么留什么的预演', !!deleteTarget &&
      !!(await waitForCondition(win, `return !!document.querySelector('.delete-modal')`)) &&
      await evaluate(win, `const t = document.querySelector('.delete-modal').innerText;
        return t.includes('不能撤销') && t.includes('会删掉') && t.includes('会留下') && t.includes('个知识点')`))
    check('删除弹窗把"移入回收站"和"彻底删除"分开', await evaluate(win,
      `const labels = Array.from(document.querySelectorAll('.delete-modal button')).map(b => b.textContent.trim());
       return labels.includes('移入回收站') && labels.includes('彻底删除…')`))
    await saveShot(win, '21-删除确认')

    check('移入回收站后从列表消失但数据仍在', await evaluate(win,
      `Array.from(document.querySelectorAll('.delete-modal button')).find(b => b.textContent.trim() === '移入回收站').click(); return true`) &&
      !!(await waitForCondition(win, `return !document.querySelector('.delete-modal') &&
        !Array.from(document.querySelectorAll('.history-row')).some(r => r.innerText.includes(${JSON.stringify(deleteTarget)}))`)) &&
      !!uiDb.prepare('SELECT deleted_at FROM sessions WHERE title = ?').get(deleteTarget).deleted_at &&
      uiDb.prepare(`SELECT COUNT(*) AS n FROM turns WHERE session_id = (SELECT id FROM sessions WHERE title = ?)`)
        .get(deleteTarget).n > 0)

    check('删除后给出撤销入口', !!(await waitForCondition(win, `return !!document.querySelector('.history-undo')`)))
    check('撤销能把刚删的场次放回来', await evaluate(win,
      `document.querySelector('.history-undo button').click(); return true`) &&
      !!(await waitForCondition(win,
        `return Array.from(document.querySelectorAll('.history-row')).some(r => r.innerText.includes(${JSON.stringify(deleteTarget)}))`)) &&
      uiDb.prepare('SELECT deleted_at FROM sessions WHERE title = ?').get(deleteTarget).deleted_at === null)

    // 批量：勾两场（避开当前这一场，否则会把整场学习切走），一次移入回收站，再用撤销条放回来
    const batchTitles = await evaluate(win,
      `const rows = Array.from(document.querySelectorAll('.history-row:not(.current)')).slice(0, 2);
       if (rows.length < 2) return null;
       rows.forEach(r => r.querySelector('.history-pick').click());
       return rows.map(r => r.querySelector('.history-open strong').innerText)`)
    check('勾选多场后能一次移入回收站', Array.isArray(batchTitles) && batchTitles.length === 2 &&
      !!(await waitForCondition(win, `return !!document.querySelector('.history-batch')`)) &&
      await evaluate(win,
        `Array.from(document.querySelectorAll('.history-batch button')).find(b => b.textContent.trim() === '移入回收站').click(); return true`) &&
      !!(await waitForCondition(win,
        `return !Array.from(document.querySelectorAll('.history-row')).some(r => ${JSON.stringify(batchTitles)}.some(t => r.innerText.includes(t)))`)) &&
      batchTitles.every((title) =>
        !!uiDb.prepare('SELECT deleted_at FROM sessions WHERE title = ?').get(title).deleted_at) &&
      !!(await waitForCondition(win, `return !!document.querySelector('.history-undo')`)) &&
      await evaluate(win, `document.querySelector('.history-undo button').click(); return true`) &&
      !!(await waitForCondition(win,
        `return ${JSON.stringify(batchTitles)}.every(t => Array.from(document.querySelectorAll('.history-row')).some(r => r.innerText.includes(t)))`)))

    // 再删一次，这回从回收站里彻底删掉
    await evaluate(win,
      `const row = Array.from(document.querySelectorAll('.history-modal .history-row'))
         .find(r => r.innerText.includes(${JSON.stringify(deleteTarget)}));
       Array.from(row.querySelectorAll('.history-actions button')).find(b => b.textContent.trim() === '删除').click();
       return true`)
    await waitForCondition(win, `return !!document.querySelector('.delete-modal')`)
    await evaluate(win,
      `Array.from(document.querySelectorAll('.delete-modal button')).find(b => b.textContent.trim() === '移入回收站').click(); return true`)
    await waitForCondition(win, `return !document.querySelector('.delete-modal')`)
    check('回收站视图显示场次、占用和自动清理时间', await evaluate(win,
      `Array.from(document.querySelectorAll('.history-tabs button')).find(b => b.textContent.includes('回收站')).click(); return true`) &&
      !!(await waitForCondition(win, `const t = document.querySelector('.history-trash-head')?.innerText || '';
        return t.includes('占用') && t.includes('自动清理') && !!document.querySelector('.history-row.trash')`)))
    await saveShot(win, '22-回收站')

    check('彻底删除要切换确认并亲手输入"删除"', await evaluate(win,
      `const row = Array.from(document.querySelectorAll('.history-row.trash'))
         .find(r => r.innerText.includes(${JSON.stringify(deleteTarget)}));
       Array.from(row.querySelectorAll('button')).find(b => b.textContent.trim() === '彻底删除').click(); return true`) &&
      !!(await waitForCondition(win, `return !!document.querySelector('.delete-modal')`)) &&
      await evaluate(win,
        `Array.from(document.querySelectorAll('.delete-modal button')).find(b => b.textContent.trim() === '彻底删除…').click(); return true`) &&
      !!(await waitForCondition(win, `return !!document.querySelector('[aria-label="彻底删除确认"]')`)) &&
      await evaluate(win,
        `const btn = Array.from(document.querySelectorAll('.delete-modal button')).find(b => b.textContent.trim() === '彻底删除');
         return !!btn && btn.disabled`) &&
      await evaluate(win, fillHelper('[aria-label="彻底删除确认"]', '删除')) &&
      !!(await waitForCondition(win,
        `const btn = Array.from(document.querySelectorAll('.delete-modal button')).find(b => b.textContent.trim() === '彻底删除');
         return !!btn && !btn.disabled`)))

    check('彻底删除真的删掉对话与独占知识点的记录', await evaluate(win,
      `Array.from(document.querySelectorAll('.delete-modal button')).find(b => b.textContent.trim() === '彻底删除').click(); return true`) &&
      !!(await waitForCondition(win, `return !document.querySelector('.delete-modal')`)) &&
      uiDb.prepare('SELECT COUNT(*) AS n FROM sessions WHERE title = ?').get(deleteTarget).n === 0 &&
      uiDb.prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id NOT IN (SELECT id FROM sessions)').get().n === 0)
    await evaluate(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await waitForCondition(win, `return !document.querySelector('.history-modal')`)
    await evaluate(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await evaluate(win, clickHelper('笔记'))
    await waitForCondition(win, `return !!document.querySelector('.notes-detail .note-block')`)
    check('笔记不再有彩色竖条', await evaluate(win, `return Array.from(document.querySelectorAll('.note-block')).every(el => getComputedStyle(el).borderLeftWidth === '0px')`))
    await evaluate(win, `Array.from(document.querySelectorAll('.note-block-actions button')).find(b => b.textContent.trim() === '置顶')?.click()`)
    check('笔记置顶实际保存并刷新', !!(await waitForCondition(win, `return !!document.querySelector('.note-block-actions button[aria-pressed=true]')`)))
    check('置顶状态写入数据库', noteDb.prepare('SELECT COUNT(*) AS n FROM note_blocks WHERE pinned = 1').get().n > 0)
    await evaluate(win, fillHelper('.notes-query', '没有这个笔记内容'))
    check('笔记内容搜索可筛空', !!(await waitForCondition(win, `return document.querySelector('.notes-page-head span')?.innerText === '0 张卡片'`)))
    await evaluate(win, clickHelper('清除筛选'))
    check('清除筛选恢复笔记', !!(await waitForCondition(win, `return !!document.querySelector('.notes-detail .note-card')`)))
    await evaluate(win, clickHelper('搜索'))
    await waitForCondition(win, `return !!document.querySelector('.search-modal')`)
    check('弹窗正确标记模态并隔离背景', await evaluate(win, `return document.querySelector('.search-modal')?.getAttribute('aria-modal') === 'true' && document.querySelector('.sidebar').inert`))
    await evaluate(win, `const last = document.querySelectorAll('.search-modal button'); last[last.length - 1].focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', bubbles:true, cancelable:true}));`)
    check('Tab 焦点被约束在弹窗', await evaluate(win, `return document.activeElement === document.querySelector('.search-modal button')`))
    await evaluate(win, `const input = document.querySelector('.search-input'); input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true}));`)
    await evaluate(win, `document.querySelector('.search-input').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));`)
    check('搜索支持方向键和回车打开设置', !!(await waitForCondition(win, `return !!document.querySelector('.settings-fields')`)))
    await evaluate(win, `window.__originalFetch = window.fetch; window.fetch = (url, init) => String(url).endsWith('/settings') && init?.method === 'POST' ? Promise.resolve(new Response(JSON.stringify({message:'模拟保存失败'}), {status:500})) : window.__originalFetch(url, init);`)
    await evaluate(win, `document.querySelector('.settings-fields .btn.primary')?.click()`)
    check('设置保存失败显示可见错误', !!(await waitForCondition(win, `return document.querySelector('.settings-fields [role=alert]')?.innerText.includes('模拟保存失败')`)))
    await evaluate(win, `window.fetch = window.__originalFetch; delete window.__originalFetch;`)
    await evaluate(win, `window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`)
    check('关闭弹窗恢复背景交互', await evaluate(win, `return !document.querySelector('.sidebar').inert`))
    await evaluate(win, clickHelper('对话'))
    win.setSize(940, 680)
    await sleep(300)
    check('最小窗口不产生横向溢出', await evaluate(win, `return document.documentElement.scrollWidth <= innerWidth`))
    check('窄窗口侧栏可按需展开', await evaluate(win, clickHelper('本场笔记')) && !!(await waitForCondition(win, `return getComputedStyle(document.querySelector('.rightbar')).display === 'flex'`)))
    await saveShot(win, '18-小窗口')
    win.setSize(1280, 840)
    await evaluate(win, clickHelper('新的一场'))
    await evaluate(win, clickHelper('我有具体问题'))
    await evaluate(win, `window.__originalFetch = window.fetch; window.fetch = (url, init) => String(url).endsWith('/chat') ? Promise.resolve(new Response(new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode('event: delta\\ndata: {"text":"模拟中断的部分回复"}\\n\\n')); setTimeout(() => controller.error(new Error('模拟断流')), 80); }}), {headers: {'Content-Type':'text/event-stream'}})) : window.__originalFetch(url, init); const input = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input, '验证中断后恢复'); input.dispatchEvent(new Event('input',{bubbles:true}));`)
    await evaluate(win, clickHelper('发送'))
    check('回复断流保留部分文字并释放输入框', !!(await waitForCondition(win, `return document.querySelector('.interrupted-label') && !document.querySelector('.composer textarea').disabled && document.querySelector('.msg.assistant')?.innerText.includes('模拟中断的部分回复')`)))
    check('失败问题恢复到草稿且有错误反馈', await evaluate(win, `return document.querySelector('.composer textarea').value === '验证中断后恢复' && document.querySelector('[role=alert]')?.innerText.includes('中断')`))
    await evaluate(win, `window.fetch = window.__originalFetch; delete window.__originalFetch;`)
    await saveShot(win, '19-断流恢复')

    await evaluate(win, `window.__originalFetch = window.fetch; window.fetch = async (url, init) => {
      if (String(url).includes('/turns')) { window.__turnCalls = (window.__turnCalls || 0) + 1; if (window.__turnCalls === 1) await new Promise(r => setTimeout(r, 400)); }
      return window.__originalFetch(url, init);
    }; const buttons = document.querySelectorAll('.recent-session'); window.__raceTitle = buttons[1].title; buttons[0].click();`)
    await sleep(30)
    await evaluate(win, `document.querySelectorAll('.recent-session')[1].click()`)
    await sleep(650)
    check('快速切换场次时旧请求不会覆盖最新选择', await evaluate(win, `return document.querySelector('.main-title').textContent === window.__raceTitle`))
    await evaluate(win, `window.fetch = window.__originalFetch; delete window.__originalFetch; const input = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input, '这场学习尚未发送的草稿'); input.dispatchEvent(new Event('input',{bubbles:true}));`)
    await sleep(50)
    await evaluate(win, `document.querySelectorAll('.recent-session')[0].click()`)
    await sleep(250)
    check('切换场次不会携带另一场的草稿', await evaluate(win, `return document.querySelector('.composer textarea').value !== '这场学习尚未发送的草稿'`))
    await evaluate(win, `document.querySelectorAll('.recent-session')[1].click()`)
    await sleep(250)
    check('切回原场次恢复未发送草稿', await evaluate(win, `return document.querySelector('.composer textarea').value === '这场学习尚未发送的草稿'`))
    await evaluate(win, `window.__originalFetch = window.fetch; window.fetch = (url, init) => String(url).endsWith('/chat') ? Promise.resolve(new Response(new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode('event: delta\\ndata: {"text":"正在生成"}\\n\\n'));
      setTimeout(() => { try { controller.enqueue(new TextEncoder().encode('event: delta\\ndata: {"text":"不应出现在新场次"}\\n\\nevent: done\\ndata: {}\\n\\n')); controller.close(); } catch {} }, 600);
    }}))) : window.__originalFetch(url, init);`)
    await evaluate(win, clickHelper('发送'))
    await waitForCondition(win, `return document.querySelector('.msg.assistant:last-child')?.innerText.includes('正在生成')`)
    await evaluate(win, clickHelper('新的一场'))
    await sleep(800)
    check('生成途中新建场次不会混入旧回复', await evaluate(win, `return !!document.querySelector('.start-card') && !document.querySelector('.msg') && !document.body.innerText.includes('不应出现在新场次')`))
    await evaluate(win, `window.fetch = window.__originalFetch; delete window.__originalFetch;`)

    // ── 10. 样式确实加载了 ──
    const bg = await evaluate(win, `return getComputedStyle(document.body).backgroundColor`)
    check('样式表已生效（不是默认白底）', bg !== 'rgba(0, 0, 0, 0)' && bg !== 'rgb(255, 255, 255)', `背景色 ${bg}`)
    const fontFamily = await evaluate(win, `return getComputedStyle(document.body).fontFamily`)
    check('字体设置已生效', fontFamily.includes('Segoe UI') || fontFamily.includes('YaHei'), fontFamily.slice(0, 60))

    // ── 11. 控制台没有报错 ──
    await sleep(300)
    check('渲染进程没有控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))
  } catch (err) {
    check('界面验证过程本身出错了', false, err instanceof Error ? err.message : String(err))
  }

  const lines = ['──── 界面验证 ────']
  for (const r of results) lines.push(`${r.ok ? '  ✓' : '  ✕'} ${r.name}${r.detail ? `  —  ${r.detail}` : ''}`)
  for (const note of report) lines.push(`  · ${note}`)
  lines.push('──────────────────')
  lines.push(failed === 0 ? `界面验证全部通过（${results.length} 项）` : `界面验证有 ${failed} 项未通过`)

  const text = lines.join('\n')
  console.log('\n' + text + '\n')
  try {
    const fs = require('node:fs')
    const os = require('node:os')
    fs.appendFileSync(join(os.tmpdir(), 'zhitu-e2e-report.txt'), `\n[界面]\n${text}\n`, 'utf-8')
  } catch {
    /* 报告文件写不了不影响退出码 */
  }

  if (mock) await mock.close()
  app.exit(failed === 0 ? 0 : 1)
})
