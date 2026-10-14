const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const dir = mkdtempSync(join(tmpdir(), 'zhitu-complete-ui-'))
process.env.ZHITU_DATA_DIR = dir
const output = process.env.ZHITU_COMPLETENESS_OUTPUT || join(dir, 'shots'); mkdirSync(output, { recursive: true })
require(join(__dirname, '..', 'out/main/index.js'))
const results = []; const errors = []; let mock
app.on('browser-window-created', (_, win) => win.webContents.on('console-message', e => { if (e.level === 'error' && !String(e.message).includes('net::ERR')) errors.push(e.message) }))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const check = (name, ok) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`) }
const evaluate = (win, code) => win.webContents.executeJavaScript(`(async()=>{${code}})()`, true)
async function until(win, code, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await evaluate(win, code)) return true; await sleep(100) } return false }
const click = (win, text) => evaluate(win, `const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true;`)
const fill = (win, selector, value) => evaluate(win, `const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;`)
async function api(path, body, method = body ? 'POST' : 'GET') { const r = await fetch(`http://127.0.0.1:${globalThis.__zhitu.port}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Zhitu-Token': globalThis.__zhitu.token }, ...(body ? { body: JSON.stringify(body) } : {}) }); if (!r.ok) throw Error(`${path} ${r.status}: ${await r.text()}`); return r.json() }
async function upload(name, bytes) { const form = new FormData();form.append('file', new Blob([bytes]), name);form.append('libraryImport','true');const r = await fetch(`http://127.0.0.1:${globalThis.__zhitu.port}/attachments`, { method: 'POST', headers: { 'X-Zhitu-Token': globalThis.__zhitu.token }, body: form });return (await r.json()).attachment }
async function shot(win, name) { await sleep(250);writeFileSync(join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG()) }
const titles = ['为什么学习率过大会让梯度下降来回震荡','交叉熵与均方误差在分类任务中的差别','怎样判断模型过拟合以及如何使用验证集','数据泄漏为什么让测试集准确率虚高','批量归一化在训练与推理时有何差别','正则化与提前停止应该怎样搭配使用','随机梯度下降与Adam的收敛路径比较','混淆矩阵中的精确率与召回率如何解释','类别不平衡为什么不能只看准确率','特征标准化如何影响距离与优化','循环神经网络的梯度消失如何缓解','注意力机制为什么需要缩放点积','位置编码如何保留序列顺序信息','迁移学习时应该冻结哪些网络层','交叉验证应该在何时进行数据预处理','模型校准与可靠性曲线如何解读','如何设计能复现的机器学习实验']
app.whenReady().then(async()=>{
  try {
    for(let i=0;i<100&&!globalThis.__zhitu;i++)await sleep(100)
    const db = globalThis.__zhitu.db.db; const win=BrowserWindow.getAllWindows()[0]
    if(win.webContents.isLoading())await new Promise(r=>win.webContents.once('did-finish-load',r))
    win.setSize(1380,920)
    mock = await require('./mock-provider.cjs').startMockProvider()
    await api('/settings',{providerId:'custom',baseURL:mock.baseURL,model:'mock-text',apiKey:'synthetic-ui-only',onboarded:true,visionEnabled:true,visionModel:'mock-vision'})
    const now=new Date().toISOString()
    for(let i=0;i<120;i++)db.prepare('INSERT INTO sessions(id,title,started_at,ended_at,archived_at) VALUES(?,?,?,?,?)').run(`history-${i}`,i===0?'最早普通课程哨兵':i===1?'最早归档课程哨兵':`历史课程 ${i}`,new Date(Date.now()-i*60000).toISOString(),now,i%3===1?now:null)
    // The earliest sentinels need to be beyond the old fifty-record limit.
    db.prepare('UPDATE sessions SET started_at=? WHERE id IN (?,?)').run('2025-01-01T00:00:00.000Z','history-0','history-1')
    for(const count of [17,50,100]) {
      const topic=`map-${count}`; db.prepare('INSERT INTO topics(id,title,created_at) VALUES(?,?,?)').run(topic,`${count}个长标题测试`,now)
      for(let i=0;i<count;i++) { const id=`${topic}-${i}`;db.prepare('INSERT INTO nodes(id,topic_id,title,kind,status,mastery,created_at,updated_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,topic,`${titles[i%17]}${i>=17?`（延伸 ${i+1}）`:''}`,'concept','gathered',i%6,now,now,now);if(i)db.prepare('INSERT INTO edges(id,src_id,dst_id,type,created_at) VALUES(?,?,?,?,?)').run(`edge-${id}`,`${topic}-${Math.floor((i-1)/2)}`,id,'parent',now) }
    }
    const image=await upload('草稿校对测试.png',readFileSync(join(__dirname,'fixtures/attachments/sample.png')))
    await api(`/library/${image.id}/start`,{mode:'handwriting',startPage:1,endPage:1})
    let job
    for(let i=0;i<200;i++){job=(await api('/library/'+image.id)).analysis;if(job.status==='done')break;await sleep(100)}
    if(job.status!=='done')throw Error('analysis timeout')
    const second=await upload('第二份资料.txt',Buffer.from('用于测试资料切换的合成原文。'))
    win.reload();await until(win,`return !!document.querySelector('.shell')`)
    await click(win,'资料库');await until(win,`return document.querySelectorAll('.library-file').length===2`)
    const choose=id=>evaluate(win,`const buttons=Array.from(document.querySelectorAll('.library-file'));const b=buttons.find(b=>b.innerText.includes(${JSON.stringify(id===image.id?'草稿校对测试.png':'第二份资料.txt')}));b?.click();return !!b;`)
    await choose(image.id);await until(win,`return document.querySelectorAll('.library-note').length===2`)
    await click(win,'修改分类 / 内容');await fill(win,'input[aria-label="笔记标题"]','未保存标题草稿哨兵')
    check('编辑时明确显示草稿已保存到本机',await until(win,`return document.querySelector('.library-draft-status')?.innerText.includes('草稿已保存在本机')`))
    await choose(second.id);await choose(image.id)
    check('切换文件后未提交的笔记标题自动恢复',await until(win,`return document.querySelector('input[aria-label="笔记标题"]')?.value==='未保存标题草稿哨兵'`))
    await click(win,'对话');await click(win,'资料库')
    check('离开页面回来仍恢复笔记编辑状态',await until(win,`return document.querySelector('input[aria-label="笔记标题"]')?.value==='未保存标题草稿哨兵'`))
    win.reload();await until(win,`return !!document.querySelector('.shell')`);await click(win,'资料库')
    check('刷新应用后从持久化存储恢复笔记草稿',await until(win,`return document.querySelector('input[aria-label="笔记标题"]')?.value==='未保存标题草稿哨兵'`))
    await shot(win,'01-笔记草稿恢复')
    await evaluate(win,`window.__storageSave=Storage.prototype.setItem;window.__confirm=window.confirm;Storage.prototype.setItem=function(k,v){if(k.startsWith('zhitu.library.draft'))throw new Error('synthetic quota');return window.__storageSave.call(this,k,v)};window.confirm=()=>false;return true;`)
    await fill(win,'input[aria-label="笔记标题"]','存储失败时保护草稿')
    check('本机存储失败显示原因并提供草稿导出',await until(win,`return document.body.innerText.includes('本机草稿保存失败')&&Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='导出草稿')`))
    await click(win,'对话');check('拒绝丢弃未持久化修改后仍留在编辑页面',await evaluate(win,`return !!document.querySelector('.library-page')&&document.querySelector('input[aria-label="笔记标题"]')?.value==='存储失败时保护草稿';`))
    await evaluate(win,`Storage.prototype.setItem=window.__storageSave;window.confirm=window.__confirm;return true;`)
    await fill(win,'input[aria-label="笔记标题"]','未保存标题草稿哨兵');await click(win,'保存笔记');await until(win,`return document.body.innerText.includes('笔记修改已保存')`)
    check('正式保存后清除对应笔记草稿',await evaluate(win,`const d=localStorage.getItem(${JSON.stringify('zhitu.library.draft.v1.'+image.id)});return !d||!JSON.parse(d).note;`))
    await click(win,'原文与校对');await click(win,'校对原文');await fill(win,'.library-sources textarea','未保存原文校对草稿哨兵：磷脂双分子层。')
    await click(win,'对话');win.reload();await until(win,`return !!document.querySelector('.shell')`);await click(win,'资料库')
    check('重启页面后原文校对草稿及编辑页签恢复',await until(win,`return document.querySelector('.library-sources textarea')?.value.includes('未保存原文校对草稿哨兵')`))
    await shot(win,'02-原文校对草稿恢复');await click(win,'保存校对');await until(win,`return document.body.innerText.includes('校对已保存')`)
    await evaluate(win,`Array.from(document.querySelectorAll('.sidebar button')).find(b=>b.textContent.includes('搜索'))?.click();return true;`);await until(win,`return !!document.querySelector('.search-input[aria-label="搜索内容"]')`);await fill(win,'input[aria-label="搜索内容"]','未保存标题草稿哨兵')
    check('全局搜索展示资料库整理结果',await until(win,`return document.querySelector('.search-results')?.innerText.includes('资料库整理')`))
    await evaluate(win,`document.querySelector('.search-results button')?.click();return true;`)
    check('搜索结果直达资料并突出对应笔记和原文依据',await until(win,`return document.querySelector('.library-note.search-located')?.innerText.includes('未保存标题草稿哨兵')&&!!document.querySelector('.library-proof')`))
    await shot(win,'03-资料库搜索定位')
    await evaluate(win,`Array.from(document.querySelectorAll('.sidebar button')).find(b=>b.textContent.includes('学习记录'))?.click();return true;`)
    await fill(win,'input[aria-label="筛选学习记录"]','最早普通课程哨兵')
    check('历史标题搜索可到达最早普通记录',await until(win,`return document.querySelector('.history-records')?.innerText.includes('最早普通课程哨兵')`))
    await fill(win,'input[aria-label="筛选学习记录"]','最早归档课程哨兵')
    await evaluate(win,`Array.from(document.querySelectorAll('.history-modal button')).find(b=>b.textContent.includes('已归档（'))?.click();return true;`)
    check('归档搜索只显示匹配的最早记录',await until(win,`return document.querySelectorAll('.history-records .history-row').length===1&&document.querySelector('.history-records')?.innerText.includes('最早归档课程哨兵')`))
    await shot(win,'04-最早归档记录检索')
    await click(win,'改名');await fill(win,'input[aria-label="新的名字"]','归档改名哨兵');await click(win,'保存');await fill(win,'input[aria-label="筛选学习记录"]','归档改名哨兵')
    check('归档记录可在界面改名',await until(win,`return document.querySelector('.history-records')?.innerText.includes('归档改名哨兵')`))
    await evaluate(win,`document.querySelector('.history-pick')?.click();return true;`);await click(win,'移入回收站')
    check('归档记录可勾选并批量移入回收站',await until(win,`return !!document.querySelector('.history-undo')&&!document.querySelector('.history-records .history-row')`))
    await click(win,'关闭')
    for(const count of [17,50,100]) {
      await click(win,'地图');await until(win,`return !!document.querySelector('.map-head select option[value="map-${count}"]')`)
      await evaluate(win,`const e=document.querySelector('.map-head select');e.value='map-${count}';e.dispatchEvent(new Event('change',{bubbles:true}));return true;`)
      await until(win,`return document.querySelector('.map-page')?.dataset.topicId==='map-${count}'&&document.querySelector('.map-page')?.getAttribute('aria-busy')==='false'`);await click(win,'全览')
      check(`${count}个长标题地图可渲染且目录完整`,await until(win,`return document.querySelector('.map-canvas')?.dataset.renderNodes==='${count}'&&document.querySelectorAll('.map-outline button').length===${count}`))
      await shot(win,`05-地图${count}点全览`)
      if(count===100){await fill(win,'input[aria-label="查找地图知识点"]','延伸 100');await evaluate(win,`document.querySelector('.map-outline button')?.click();return true;`);check('100点目录可搜索并定位完整标题',await until(win,`return document.querySelector('.map-info strong')?.innerText.includes('延伸 100')`));await shot(win,'06-地图100点查找定位')}
      await click(win,'对话')
    }
    await click(win,'导出');await until(win,`return !!document.querySelector('.backup-picker input')`)
    await evaluate(win,`const dt=new DataTransfer();dt.items.add(new File(['{}'],'invalid.json',{type:'application/json'}));const e=document.querySelector('.backup-picker input');e.files=dt.files;e.dispatchEvent(new Event('change',{bubbles:true}));return true;`)
    check('界面拒绝无效备份并显示原因',await until(win,`return document.querySelector('.backup-restore [role=alert]')?.innerText.includes('不是支持的织图备份')`))
    await evaluate(win,`const r=await fetch(window.zhitu.baseURL+'/exports/all',{headers:{'X-Zhitu-Token':window.zhitu.token}});const data=await r.text();const dt=new DataTransfer();dt.items.add(new File([data],'织图-验收备份.json',{type:'application/json'}));const e=document.querySelector('.backup-picker input');e.files=dt.files;e.dispatchEvent(new Event('change',{bubbles:true}));return true;`)
    check('有效备份先预览数量及合并规则',await until(win,`return document.querySelector('.backup-preview')?.innerText.includes('以新副本加入')&&!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='保存快照并恢复这份备份')`))
    await shot(win,'07-备份恢复预览');const before=db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
    await click(win,'保存快照并恢复这份备份')
    check('从界面完整恢复并给出快照路径与重新加载入口',await until(win,`return document.querySelector('.backup-message')?.innerText.includes('恢复完成')`,30000)&&db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n===before*2)
    const settingsAfter=(await api('/bootstrap')).settings
    check('恢复后仍保留当前本机模型配置与加密测试密钥',settingsAfter.hasApiKey&&settingsAfter.baseURL===mock.baseURL&&settingsAfter.model==='mock-text')
    await shot(win,'08-备份恢复完成')
    await click(win,'完成并重新加载');await until(win,`return !!document.querySelector('.shell')`)
    // Leave two unsaved drafts for a separate Electron process to reopen.
    const saved=JSON.parse(db.prepare('SELECT payload_json FROM document_analyses WHERE attachment_id=?').get(image.id).payload_json)
    saved.status='done';delete saved.previousResult;delete saved.previousSources;saved.updatedAt=new Date().toISOString()
    db.prepare('UPDATE document_analyses SET payload_json=? WHERE attachment_id=?').run(JSON.stringify(saved),image.id)
    await click(win,'资料库');await until(win,`return document.querySelectorAll('.library-note').length===2`)
    await click(win,'修改分类 / 内容');await fill(win,'input[aria-label="笔记标题"]','应用关闭后恢复标题哨兵')
    await click(win,'原文与校对');await click(win,'校对原文');await fill(win,'.library-sources textarea','应用关闭后恢复原文哨兵。')
    check('应用关闭前两种草稿同时持久化',await evaluate(win,`const d=JSON.parse(localStorage.getItem(${JSON.stringify('zhitu.library.draft.v1.'+image.id)}));return d?.note?.title==='应用关闭后恢复标题哨兵'&&d?.sources?.[0]?.text==='应用关闭后恢复原文哨兵。';`))
    check('渲染流程无 JavaScript 错误',errors.length===0)
    writeFileSync(join(output,'界面验收.json'),JSON.stringify({sandbox:dir,version:app.getVersion(),results,errors},null,2))
    console.log(`UI: ${results.filter(r=>r.ok).length}/${results.length} passed. ${output}`)
    await mock.close();await sleep(500);if(results.every(r=>r.ok))app.quit();else app.exit(1)
  }catch(e){console.error(e.stack);if(mock)await mock.close();app.exit(1)}
})
