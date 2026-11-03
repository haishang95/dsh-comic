// test/ui.test.mjs — 界面这一层的纯逻辑：设置读写、封面白名单、客户端脚本形态。
// 不碰网络、不碰 Python，跑起来是毫秒级。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { DEFAULT_SETTINGS, ENTRY_MODES, SAVE_MODES, createSettingsStore, normalizeSettings } from '../lib/settings.js'
import { isAllowedCoverUrl } from '../lib/routes.js'

const here = path.dirname(fileURLToPath(import.meta.url))

test('normalizeSettings：认不出的入口形态退回默认（悬浮图标）', () => {
  assert.equal(normalizeSettings({ entryMode: 'sidebar' }).entryMode, 'sidebar')
  assert.equal(normalizeSettings({ entryMode: 'floating' }).entryMode, 'floating')
  assert.equal(normalizeSettings({ entryMode: 'off' }).entryMode, 'off')
  // 垃圾值不该把用户丢进「界面上什么入口都没有」的状态
  assert.equal(normalizeSettings({ entryMode: 'sidebar ' }).entryMode, 'sidebar')
  assert.equal(normalizeSettings({ entryMode: 'popup' }).entryMode, 'floating')
  assert.equal(normalizeSettings({ entryMode: 123 }).entryMode, 'floating')
  // off 仍然合法（手改 settings.json 才能设），只是界面里不摆这个选项
  assert.deepEqual([...ENTRY_MODES], ['off', 'sidebar', 'floating'])
  assert.equal(DEFAULT_SETTINGS.entryMode, 'floating')
})

test('normalizeSettings：downloadDir 去空格、directToFolder 只认布尔', () => {
  assert.equal(normalizeSettings({ downloadDir: '  D:/漫画  ' }).downloadDir, 'D:/漫画')
  assert.equal(normalizeSettings({ downloadDir: null }).downloadDir, '')
  assert.equal(normalizeSettings({ directToFolder: false }).directToFolder, false)
  assert.equal(normalizeSettings({ directToFolder: 'false' }).directToFolder, DEFAULT_SETTINGS.directToFolder)
  assert.equal(normalizeSettings({}).entryMode, 'floating')
})

test('settings store：写进去能读回来，坏文件退回默认值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-comic-set-'))
  const file = path.join(dir, 'settings.json')

  const store = createSettingsStore({ file })
  // 文件不存在 → 默认值，不抛
  assert.deepEqual(store.read(), DEFAULT_SETTINGS)

  const saved = store.write({ entryMode: 'floating', downloadDir: 'D:/本子' })
  assert.equal(saved.entryMode, 'floating')
  assert.equal(saved.downloadDir, 'D:/本子')
  assert.equal(saved.directToFolder, DEFAULT_SETTINGS.directToFolder)

  // 只改一个字段，别的保留
  const saved2 = store.write({ directToFolder: false })
  assert.equal(saved2.entryMode, 'floating')
  assert.equal(saved2.downloadDir, 'D:/本子')
  assert.equal(saved2.directToFolder, false)

  // 重新开一个 store 读同一个文件，等于落盘成功
  const reopened = createSettingsStore({ file }).read()
  assert.equal(reopened.entryMode, 'floating')
  assert.equal(reopened.directToFolder, false)

  // 坏 JSON → 默认值，不让界面白屏
  fs.writeFileSync(file, '{ 这不是 json', 'utf8')
  assert.deepEqual(createSettingsStore({ file }).read(), DEFAULT_SETTINGS)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('封面白名单：只放行图床域名，挡住本机与任意 URL', () => {
  assert.equal(isAllowedCoverUrl('https://cdn-msp3.jmapiproxy2.cc/media/albums/498992_3x4.jpg'), true)
  assert.equal(isAllowedCoverUrl('https://cdn-msp.jmapiproxy1.cc/media/albums/498992.jpg'), true)
  assert.equal(isAllowedCoverUrl('http://cdn.jmcomic.me/media/albums/1.jpg'), true)

  // 内网 / 本机 / 文件协议 / IPv6 回环 / 空值 一律不许
  assert.equal(isAllowedCoverUrl('http://127.0.0.1:2541/api/x'), false)
  assert.equal(isAllowedCoverUrl('http://localhost/x.jpg'), false)
  assert.equal(isAllowedCoverUrl('http://192.168.1.9/x.jpg'), false)
  assert.equal(isAllowedCoverUrl('file:///C:/Windows/win.ini'), false)
  assert.equal(isAllowedCoverUrl('https://example.com/x.jpg'), false)
  assert.equal(isAllowedCoverUrl(''), false)
  assert.equal(isAllowedCoverUrl(null), false)
  assert.equal(isAllowedCoverUrl('不是网址'), false)
})

test('客户端脚本：按 ModuleLoader 的形态加载，id 与包名一致', () => {
  const file = path.join(here, '..', 'lib', 'client.js')
  const source = fs.readFileSync(file, 'utf8')

  assert.match(source, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(source, /id:\s*'dsh-comic'/)
  assert.match(source, /factory:\s*\(require\)\s*=>/)
  assert.match(source, /require\('react'\)/)
  assert.match(source, /exports\.apply\s*=\s*apply/)
  // 入口只有两个槽位；设置面板挂在面板自己的「设置」按钮里，不再往 settings 槽位注册
  for (const slot of ['shell.overlay', 'sidebar.footer.action']) {
    assert.ok(source.includes(`'${slot}'`), `缺少槽位注册：${slot}`)
  }
  // 这两个槽位在本 profile 里挂不出来（ui-settings 被 disabled），别再往里注册
  for (const dead of ['settings.plugins.tab', 'plugins.bundle.config']) {
    assert.ok(!source.includes(`'${dead}'`), `不该再注册死槽位：${dead}`)
  }
})

test('设置：成品形态三选一，默认 pdf，垃圾值退回默认', () => {
  assert.deepEqual([...SAVE_MODES], ['pdf', 'images', 'both'])
  assert.equal(DEFAULT_SETTINGS.saveMode, 'pdf')
  for (const mode of SAVE_MODES) assert.equal(normalizeSettings({ saveMode: mode }).saveMode, mode)
  assert.equal(normalizeSettings({ saveMode: 'both ' }).saveMode, 'both')
  assert.equal(normalizeSettings({ saveMode: 'zip' }).saveMode, 'pdf')
  assert.equal(normalizeSettings({ saveMode: 3 }).saveMode, 'pdf')
})

test('设置 store：saveMode 能落盘、能读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-comic-save-'))
  const file = path.join(dir, 'settings.json')
  const store = createSettingsStore({ file })
  assert.equal(store.read().saveMode, 'pdf')
  store.write({ saveMode: 'both' })
  assert.equal(createSettingsStore({ file }).read().saveMode, 'both')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('客户端脚本：带成品形态选项与查看器，且只读成品目录', () => {
  const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')
  // 设置里三个选项都在
  for (const mode of ['pdf', 'images', 'both']) {
    assert.ok(source.includes(`['${mode}',`), `设置里缺 ${mode} 这一项`)
  }
  // 下载完成后的查看：面板内预览，PDF 走 iframe、图片走网格
  assert.match(source, /function Viewer/)
  assert.match(source, /\/file\?p=/)
  assert.match(source, /\/dir\?p=/)
  assert.match(source, /\/open'/)
})
