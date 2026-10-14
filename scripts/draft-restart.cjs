const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { readFileSync, writeFileSync } = require('node:fs')
if(!process.env.ZHITU_COMPLETENESS_OUTPUT)throw Error('Isolated report directory required')
const output=process.env.ZHITU_COMPLETENESS_OUTPUT
const previous=JSON.parse(readFileSync(join(output,'界面验收.json'),'utf8'))
if(!previous.sandbox.includes('zhitu-complete-ui-'))throw Error('Not a synthetic test directory')
process.env.ZHITU_DATA_DIR=previous.sandbox
require(join(__dirname,'..','out/main/index.js'))
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const evaluate=(win,code)=>win.webContents.executeJavaScript(`(async()=>{${code}})()`,true)
async function until(win,code){for(let i=0;i<150;i++){if(await evaluate(win,code))return true;await sleep(100)}return false}
app.whenReady().then(async()=>{
  try{
    const win=BrowserWindow.getAllWindows()[0]||await new Promise(r=>app.once('browser-window-created',(_,w)=>r(w)))
    if(win.webContents.isLoading())await new Promise(r=>win.webContents.once('did-finish-load',r))
    await until(win,`return !!document.querySelector('.shell')`)
    await evaluate(win,`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='资料库')?.click();return true;`)
    const source=await until(win,`return document.querySelector('.library-sources textarea')?.value==='应用关闭后恢复原文哨兵。'`)
    console.log(`${source?'PASS':'FAIL'} 完整退出并重新启动 Electron 后恢复原文校对草稿`)
    await evaluate(win,`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='整理结果')?.click();return true;`)
    const note=await until(win,`return document.querySelector('input[aria-label="笔记标题"]')?.value==='应用关闭后恢复标题哨兵'`)
    console.log(`${note?'PASS':'FAIL'} 完整退出并重新启动 Electron 后恢复笔记草稿`)
    writeFileSync(join(output,'09-完整重启草稿恢复.png'),(await win.webContents.capturePage()).toPNG())
    writeFileSync(join(output,'完整重启验收.json'),JSON.stringify({sandbox:previous.sandbox,source,note},null,2))
    app.exit(source&&note?0:1)
  }catch(e){console.error(e.stack);app.exit(1)}
})
