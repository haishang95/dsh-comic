// lib/settings.js — 界面可改的那几项设置，落在 DSH 的 data 目录里。
//
// 为什么不放 cordis.patch.yml：那份配置是宿主启动时读的静态文件，界面上一改就得重启，
// 而且写在 profile 里属于动宿主的东西。这里改成运行时读写一个小 JSON：
//   <DSH_HOME>/data/dsh-comic/settings.json
// 界面（client 半边）通过 HTTP 改它，宿主每次下载前现读——不需要重启。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 「界面入口」三选一：不显示 / 加在侧栏 / 悬浮图标。 */
export const ENTRY_MODES = ['off', 'sidebar', 'floating']

/**
 * 下载成品形态三选一（作者 2026-11-02 定）：
 *   pdf    —— 拼成 PDF，原图删掉（默认）
 *   images —— 不拼 PDF，图片按作品名留在同名文件夹里
 *   both   —— PDF 和图片文件夹都留，同名并列
 */
export const SAVE_MODES = ['pdf', 'images', 'both']

export const DEFAULT_SETTINGS = {
  // 界面入口形态。默认给悬浮图标——这个 profile 里 settings 那两个槽位挂不出来，
  // 默认 off 的话用户装完什么也看不见（2026-11-02 踩过）。
  entryMode: 'floating',
  // 下载目录。空串 = 用插件配置里的 outDir（再空就 ~/Downloads/漫画）。
  downloadDir: '',
  // true = 直接下到 downloadDir；false = 每次下载前弹目录选择框。
  directToFolder: true,
  // 下完留什么。
  saveMode: 'pdf',
}

export function dataDir() {
  const home = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, 'data', 'dsh-comic')
}

export function settingsFile() {
  return path.join(dataDir(), 'settings.json')
}

/**
 * 客户端半边的「我加载了」心跳文件。
 * 插件装了、宿主半跑着，但界面上什么都不出来时，先看这个文件的时间戳：
 * 有 = 浏览器那半真的执行过（问题在槽位/渲染）；没有 = 模块压根没被加载。
 */
export function pingFile() {
  return path.join(dataDir(), 'client-ping.json')
}

/** 把任意输入收敛成合法设置：认不出的字段保留默认，不让界面写坏文件。 */
export function normalizeSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const mode = String(source.entryMode ?? '').trim()
  const saveMode = String(source.saveMode ?? '').trim()
  return {
    entryMode: ENTRY_MODES.includes(mode) ? mode : DEFAULT_SETTINGS.entryMode,
    downloadDir: typeof source.downloadDir === 'string' ? source.downloadDir.trim() : DEFAULT_SETTINGS.downloadDir,
    directToFolder: typeof source.directToFolder === 'boolean' ? source.directToFolder : DEFAULT_SETTINGS.directToFolder,
    saveMode: SAVE_MODES.includes(saveMode) ? saveMode : DEFAULT_SETTINGS.saveMode,
  }
}

/**
 * 设置的读写门面。
 * - read() 永远返回完整对象（文件不存在/坏掉都退回默认值，界面不会白屏）
 * - write(patch) 只覆盖 patch 里出现的字段，写盘是「临时文件 + rename」，断电不会留半个文件
 */
export function createSettingsStore({ file = settingsFile() } = {}) {
  function read() {
    try {
      const raw = fs.readFileSync(file, 'utf8')
      return { ...DEFAULT_SETTINGS, ...normalizeSettings(JSON.parse(raw)) }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  function write(patch) {
    const current = read()
    const next = { ...current, ...normalizeSettings({ ...current, ...(patch || {}) }) }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      fs.renameSync(tmp, file)
    } catch {
      /* 写不进去就只在本次进程里生效；不因为存不了偏好而打断下载 */
    }
    return next
  }

  return { read, write, file }
}
