// Offline protocol regression: actual source, synthetic network streams, no user data.
const { buildSync } = require('esbuild')
const { Module } = require('node:module')
const { join } = require('node:path')
const assert = require('node:assert/strict')
function load(path) {
  const filename = join(__dirname, '..', path)
  const output = buildSync({entryPoints:[filename],bundle:true,platform:'node',format:'cjs',write:false,
    tsconfig:join(__dirname, '..', 'tsconfig.node.json')})
  const module = new Module(filename)
  module._compile(output.outputFiles[0].text, filename)
  return module.exports
}
global.window = {zhitu:{baseURL:'http://localhost', token:'test'}}
const client = load('src/renderer/api.ts')
const provider = load('src/main/core/provider.ts')
const config = {baseURL:'http://localhost/v1',apiKey:'mock-only',model:'mock'}
const originalFetch = global.fetch
const response = (parts) => new Response(new ReadableStream({start(controller) {
  for (const part of parts) controller.enqueue(new TextEncoder().encode(part))
  controller.close()
}}))
let checks = 0
async function test(name, run) { await run(); checks++; console.log(`PASS ${name}`) }
async function runClient(parts, signal) {
  global.fetch = async () => response(parts)
  const result = {text:'',done:0,errors:[],session:null}
  await client.streamChat({content:'test'}, {
    onSession:id => result.session = id, onDelta:text => result.text += text,
    onDone:() => result.done++, onError:message => result.errors.push(message)
  }, signal)
  return result
}
async function main() {
  await test('split CRLF events and UTF-8 content', async () => {
    const r = await runClient(['event: meta\r\ndata: {"sessionId":"s1"}\r', '\n\r\nevent: delta\r\ndata: {"text":"中文"}\r\n\r\n', 'event: done\r\ndata: {}'])
    assert.equal(r.text,'中文'); assert.equal(r.session,'s1'); assert.equal(r.done,1); assert.equal(r.errors.length,0)
  })
  await test('EOF without done reports interruption', async () => {
    const r = await runClient(['event: delta\ndata: {"text":"partial"}\n\n'])
    assert.equal(r.done,0); assert.equal(r.errors.length,1); assert.equal(r.text,'partial')
  })
  await test('duplicate terminal event finishes once', async () => {
    const r = await runClient(['event: done\ndata: {}\n\nevent: done\ndata: {}\n\n'])
    assert.equal(r.done,1)
  })
  await test('server error cannot also finish successfully', async () => {
    const r = await runClient(['event: error\ndata: {"message":"failed"}\n\nevent: done\ndata: {}\n\n'])
    assert.equal(r.done,0); assert.deepEqual(r.errors,['failed'])
  })
  await test('cancel suppresses stale callbacks', async () => {
    const controller = new AbortController(); controller.abort()
    const r = await runClient(['event: done\ndata: {}\n\n'], controller.signal)
    assert.equal(r.done,0); assert.equal(r.errors.length,0)
  })
  await test('reader exception is handled', async () => {
    global.fetch = async () => new Response(new ReadableStream({start(c){ c.error(new Error('reset')) }}))
    let errors = 0
    await client.streamChat({content:'test'}, {onDelta(){},onDone(){assert.fail('unexpected success')},onError(){errors++}})
    assert.equal(errors,1)
  })
  await test('upstream final line without newline is consumed', async () => {
    global.fetch = async () => response(['data: {"choices":[{"delta":{"content":"完整回答"}}]}\n', 'data: [DONE]'])
    assert.equal(await provider.streamChat(config,[],()=>{}), '完整回答')
  })
  await test('upstream silent truncation is rejected', async () => {
    global.fetch = async () => response(['data: {"choices":[{"delta":{"content":"半句"}}]}\n'])
    await assert.rejects(provider.streamChat(config,[],()=>{}), /中途断开/)
  })
  await test('finish reason supports compatible providers', async () => {
    global.fetch = async () => response(['data: {"choices":[{"delta":{"content":"回答"},"finish_reason":"stop"}]}\n'])
    assert.equal(await provider.streamChat(config,[],()=>{}), '回答')
  })
  await test('empty upstream answer is rejected', async () => {
    global.fetch = async () => response(['data: [DONE]\n'])
    await assert.rejects(provider.streamChat(config,[],()=>{}), /没有返回正文/)
  })
  console.log(`${checks} stream regressions passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { global.fetch = originalFetch; delete global.window })
