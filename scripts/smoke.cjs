/**
 * 冒烟测试：在真实的 Electron 运行时里，把地基逐项验一遍。
 *
 * 这个脚本不启动界面，也不联网，只回答一个问题：
 * "打包前的这套地基，在 Electron 里到底能不能跑？"
 *
 * 运行：npm run smoke
 */

const { app } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')

const results = []

function check(name, fn) {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) })
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) })
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) })
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) })
  }
}

app.whenReady().then(async () => {
  const tmp = mkdtempSync(join(os.tmpdir(), 'zhitu-smoke-'))
  const dbPath = join(tmp, 'test.db')

  await checkAsync('原生模块 better-sqlite3 能加载', () => {
    require('better-sqlite3')
    return 'ok'
  })

  await checkAsync('数据库能建表', () => {
    const Database = require('better-sqlite3')
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        mastery INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        src_id TEXT NOT NULL,
        dst_id TEXT NOT NULL,
        type TEXT NOT NULL
      );
    `)
    db.close()
    return '建表成功'
  })

  await checkAsync('数据能写入并读回', () => {
    const Database = require('better-sqlite3')
    const db = new Database(dbPath)
    db.prepare('INSERT INTO nodes (id, title, mastery) VALUES (?, ?, ?)').run(
      'n1',
      'softmax 为什么要减去最大值',
      2
    )
    db.prepare('INSERT INTO edges (id, src_id, dst_id, type) VALUES (?, ?, ?, ?)').run(
      'e1',
      'n1',
      'n2',
      'parent'
    )
    const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get('n1')
    db.close()
    if (!row || row.mastery !== 2) throw new Error('读回的数据不对')
    return `${row.title} / 掌握度 ${row.mastery}`
  })

  await checkAsync('关掉再打开数据还在（这一条最关键）', () => {
    const Database = require('better-sqlite3')
    const db = new Database(dbPath)
    const row = db.prepare('SELECT COUNT(*) AS n FROM nodes').get()
    db.close()
    if (row.n !== 1) throw new Error(`期望 1 条，实际 ${row.n} 条`)
    return '重新打开后数据完好'
  })

  await checkAsync('密钥加密可用（Windows 上走系统 DPAPI）', () => {
    const { safeStorage } = require('electron')
    const available = safeStorage.isEncryptionAvailable()
    if (!available) return '不可用（会退回明文存储，界面会提示）'
    const cipher = safeStorage.encryptString('sk-test-1234567890')
    const plain = safeStorage.decryptString(cipher)
    if (plain !== 'sk-test-1234567890') throw new Error('加解密结果不一致')
    return `可用，密文 ${cipher.length} 字节`
  })

  await checkAsync('本地服务能启动并响应', async () => {
    const { Hono } = require('hono')
    const { serve } = require('@hono/node-server')
    const hono = new Hono()
    hono.get('/health', (c) => c.json({ ok: true, hello: '织图' }))

    const port = await new Promise((resolve, reject) => {
      const server = serve({ fetch: hono.fetch, hostname: '127.0.0.1', port: 0 }, (info) =>
        resolve(info.port)
      )
      server.on('error', reject)
    })

    const res = await fetch(`http://127.0.0.1:${port}/health`)
    const data = await res.json()
    if (!data.ok) throw new Error('接口返回异常')
    return `127.0.0.1:${port} 正常响应`
  })

  await checkAsync('打包产物结构完整', () => {
    const { existsSync } = require('node:fs')
    const needed = [
      'out/main/index.js',
      'out/preload/index.js',
      'out/renderer/index.html'
    ]
    const missing = needed.filter((p) => !existsSync(join(__dirname, '..', p)))
    if (missing.length) throw new Error(`缺少 ${missing.join(', ')}`)
    return needed.join(' / ')
  })

  // ── 打印报告 ──
  console.log('\n──────────── 织图 · 地基自检 ────────────')
  let failed = 0
  for (const r of results) {
    console.log(`${r.ok ? '  ✓' : '  ✕'} ${r.name}${r.detail ? `  —  ${r.detail}` : ''}`)
    if (!r.ok) failed++
  }
  console.log('─────────────────────────────────────────')
  console.log(failed === 0 ? `全部通过（${results.length} 项）\n` : `${failed} 项未通过\n`)

  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* 临时目录删不掉不影响结论 */
  }

  app.exit(failed === 0 ? 0 : 1)
})
