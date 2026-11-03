// lib/routes.js — 界面用的 HTTP 接口（挂在 DSH 自带的 webServer 上）。
//
// 为什么走 HTTP 而不是「客户端直接调宿主工具」：client 半边跑在浏览器里，
// 够不到宿主进程里的 service；dsh-meme 那类插件都是同一套做法——
// 宿主 register 一条路由，浏览器 fetch 它。
//
// 路由前缀 /api/dsh-comic，只服务 127.0.0.1（DSH 默认就只监听本机）。
export const ROUTE = '/api/dsh-comic'

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { pingFile } from './settings.js'

/** 最近一次客户端心跳（进程内缓存；落盘那份给重启后排查用）。 */
let lastPing = ''

const MAX_BODY = 64 * 1024
const COVER_CACHE_LIMIT = 240
const JOB_KEEP_MS = 30 * 60 * 1000

/** 只回本机请求：这个接口能写文件、能触发下载，不该被局域网里的别人碰到。 */
function isLoopback(req) {
  const addr = String(req.socket?.remoteAddress || '')
  return addr === '' || addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function json(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try { resolve(JSON.parse(text)) } catch (error) { reject(new Error(`请求体不是合法 JSON：${error.message}`)) }
    })
    req.on('error', reject)
  })
}

/**
 * 封面图代理：浏览器直连 JM 的图床会撞 referer / CORS，这里由宿主转一手。
 * 只允许白名单里的图床域名，不做通用代理（避免变成 SSRF 跳板）。
 */
export function isAllowedCoverUrl(raw) {
  let url
  try { url = new URL(String(raw || '')) } catch { return false }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false // IP 直连一律不许
  if (host === 'localhost' || host.endsWith('.local')) return false
  const brand = /(jmapiproxy|jmcomic|18comic|jmcomiccdn)/.test(host)
  return brand
}

/**
 * 注册全部路由。返回 disposer，交给 ctx.effect 在插件卸载时摘掉
 * （否则热重载会撞 duplicate route）。
 */
export function registerComicRoutes({ webServer, service, settings, logger = console }) {
  const covers = new Map() // url -> { body, type, at }
  const jobs = new Map()
  let jobSeq = 0

  const registrations = []

  const add = (kind, routePath, handler) => {
    registrations.push(webServer.register({ kind, path: routePath, handler }))
  }

  const guard = (handler) => async (req, res) => {
    if (!isLoopback(req)) return json(res, { ok: false, error: '只接受本机请求' }, 403)
    try {
      await handler(req, res)
    } catch (error) {
      logger?.warn?.(`[dsh-comic] 路由出错：${error?.stack || error}`)
      if (!res.headersSent) json(res, { ok: false, error: String(error?.message || error) }, 500)
      else res.end()
    }
  }

  // ---- 设置 -------------------------------------------------------------
  add('exact', `${ROUTE}/settings`, guard(async (req, res) => {
    if (req.method === 'GET') return json(res, { ok: true, settings: settings.read() })
    if (req.method !== 'POST') return json(res, { ok: false, error: '只支持 GET/POST' }, 405)
    const patch = await readBody(req)
    return json(res, { ok: true, settings: settings.write(patch) })
  }))

  // ---- 搜索 -------------------------------------------------------------
  add('exact', `${ROUTE}/search`, guard(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const query = String(url.searchParams.get('q') || '').trim()
    const limit = Number(url.searchParams.get('limit') || 12)
    if (query === '') return json(res, { ok: false, error: '请输入 JM 号或漫画名' }, 400)
    const result = await service.search({ query, limit })
    return json(res, { ok: true, ...result })
  }))

  // ---- 下载（异步作业：一本要半分钟到几分钟，不能卡住一个 HTTP 请求）------
  add('exact', `${ROUTE}/download`, guard(async (req, res) => {
    if (req.method !== 'POST') return json(res, { ok: false, error: '只支持 POST' }, 405)
    const body = await readBody(req)
    const album = String(body.album || '').trim()
    if (!/^\d{1,12}$/.test(album)) return json(res, { ok: false, error: '本子号看着不对（应为纯数字）' }, 400)

    const settingsNow = settings.read()
    const outDir = String(body.outDir || '').trim() || settingsNow.downloadDir || ''

    const id = `job-${++jobSeq}`
    const job = { id, album, outDir, status: 'running', startedAt: Date.now(), finishedAt: 0, lines: [], result: null, error: '' }
    jobs.set(id, job)

    // 不 await：立刻把 id 交回去，界面轮询 /job。
    service.download({
      album,
      outDir: outDir === '' ? undefined : outDir,
      onProgress: (line) => {
        job.lines.push(String(line))
        if (job.lines.length > 8) job.lines.shift()
      },
    }).then((result) => {
      job.status = result?.ok ? 'done' : 'failed'
      job.result = result
      job.finishedAt = Date.now()
      if (!result?.ok) job.error = String(result?.reason || '下载失败')
    }).catch((error) => {
      job.status = 'failed'
      job.error = String(error?.message || error)
      job.finishedAt = Date.now()
    })

    return json(res, { ok: true, job: { id, album, outDir, status: job.status } })
  }))

  add('exact', `${ROUTE}/job`, guard(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const id = String(url.searchParams.get('id') || '')
    const job = jobs.get(id)
    if (!job) return json(res, { ok: false, error: '没有这个下载任务（可能已完成并被清理）' }, 404)
    return json(res, { ok: true, job })
  }))

  // ---- 心跳：客户端半边每次 apply 会打一下，用来确认「浏览器那半真的加载了」----
  // 排查「插件装了但界面上什么都没有」时，先看这里有没有时间戳。
  add('exact', `${ROUTE}/ping`, guard(async (req, res) => {
    if (req.method !== 'POST') return json(res, { ok: true, at: lastPing })
    lastPing = new Date().toISOString()
    try {
      fs.mkdirSync(path.dirname(pingFile()), { recursive: true })
      fs.writeFileSync(pingFile(), JSON.stringify({
        at: lastPing,
        ua: String(req.headers['user-agent'] || ''),
      }, null, 2), 'utf8')
    } catch { /* 写不进去也不影响界面 */ }
    logger.info?.(`[dsh-comic] 客户端半边已加载（${lastPing}）`)
    return json(res, { ok: true, at: lastPing })
  }))

  // ---- 成品列表 / 环境体检 ------------------------------------------------
  add('exact', `${ROUTE}/list`, guard(async (req, res) => {
    return json(res, { ok: true, ...service.list({ limit: 100 }) })
  }))

  add('exact', `${ROUTE}/status`, guard(async (req, res) => {
    // clientPing 为空 = 浏览器那半从没连上来过（插件加载问题，不是下载问题）
    return json(res, { ok: true, ...service.status(), clientPing: lastPing })
  }))

  // ---- 预览：把成品送回浏览器（PDF 进 iframe、图片进 <img>）-------------
  // 只允许成品目录内的文件：这个接口能把任意路径读成 HTTP，不设边界就是一个
  // 本地文件读取器。先 resolve 成绝对路径、再 realpath 解掉软链，两步都在根里才放行。
  const MIME = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
  }

  const insideOutDir = (target) => {
    let root = ''
    try { root = fs.realpathSync(path.resolve(service.outDir())) } catch { return '' }
    let full = ''
    try { full = fs.realpathSync(path.resolve(String(target || ''))) } catch { return '' }
    if (full !== root && !full.startsWith(root + path.sep)) return ''
    return full
  }

  add('prefix', `${ROUTE}/file`, guard(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const file = insideOutDir(url.searchParams.get('p') || '')
    if (file === '') return json(res, { ok: false, error: '只能看成品目录里的文件' }, 403)
    let stat
    try { stat = fs.statSync(file) } catch { return json(res, { ok: false, error: '文件不在了（可能被清理或改名）' }, 404) }
    if (!stat.isFile()) return json(res, { ok: false, error: '这不是文件' }, 400)

    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
    const total = stat.size
    // PDF 阅读器会按 Range 分段取页，不实现的话大文件翻页要等整本下完。
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''))
    if (match) {
      let start = match[1] === '' ? null : Number(match[1])
      let end = match[2] === '' ? null : Number(match[2])
      if (start === null && end === null) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` })
        return res.end()
      }
      if (start === null) { start = Math.max(0, total - end); end = total - 1 }
      else if (end === null || end >= total) end = total - 1
      if (start < 0 || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` })
        return res.end()
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=60',
      })
      return fs.createReadStream(file, { start, end }).pipe(res)
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=60',
    })
    return fs.createReadStream(file).pipe(res)
  }))

  /** 图片成品的目录清单（预览网格要按顺序排，前端不猜文件名）。 */
  add('exact', `${ROUTE}/dir`, guard(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const dir = insideOutDir(url.searchParams.get('p') || '')
    if (dir === '') return json(res, { ok: false, error: '只能看成品目录里的文件夹' }, 403)
    let children = []
    try { children = fs.readdirSync(dir, { withFileTypes: true }) } catch { return json(res, { ok: false, error: '文件夹不在了' }, 404) }
    const files = children
      .filter((child) => child.isFile() && MIME[path.extname(child.name).toLowerCase()])
      .map((child) => {
        const full = path.join(dir, child.name)
        let bytes = 0
        try { bytes = fs.statSync(full).size } catch { /* 读不到就 0 */ }
        return { name: child.name, path: full, bytes }
      })
      .filter((item) => item.name.toLowerCase().endsWith('.pdf') === false)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    return json(res, { ok: true, dir, count: files.length, files })
  }))

  /** 用系统默认程序打开（看完想接着翻，浏览器里终究不如本地阅读器）。 */
  add('exact', `${ROUTE}/open`, guard(async (req, res) => {
    if (req.method !== 'POST') return json(res, { ok: false, error: '只支持 POST' }, 405)
    const body = await readBody(req)
    const target = insideOutDir(body.path || '')
    if (target === '') return json(res, { ok: false, error: '只能打开成品目录里的东西' }, 403)
    try {
      const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' })
      child.unref()
      return json(res, { ok: true, path: target })
    } catch (error) {
      return json(res, { ok: false, error: `没能唤起资源管理器：${error?.message || error}` }, 500)
    }
  }))

  // ---- 封面代理 -----------------------------------------------------------
  add('prefix', `${ROUTE}/cover`, guard(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const target = String(url.searchParams.get('u') || '')
    if (!isAllowedCoverUrl(target)) return json(res, { ok: false, error: '封面地址不在白名单里' }, 400)

    const hit = covers.get(target)
    if (hit) {
      res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': 'public, max-age=86400' })
      return res.end(hit.body)
    }

    const upstream = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        Referer: 'https://18comic.vip/',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!upstream.ok) return json(res, { ok: false, error: `图床返回 ${upstream.status}` }, 502)
    const body = Buffer.from(await upstream.arrayBuffer())
    const type = upstream.headers.get('content-type') || 'image/jpeg'
    if (covers.size >= COVER_CACHE_LIMIT) {
      const oldest = covers.keys().next().value
      if (oldest !== undefined) covers.delete(oldest)
    }
    covers.set(target, { body, type, at: Date.now() })
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' })
    return res.end(body)
  }))

  // 作业记录定期清掉，别让 Map 长成内存泄漏
  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [id, job] of jobs) {
      if (job.status !== 'running' && now - job.finishedAt > JOB_KEEP_MS) jobs.delete(id)
    }
  }, 5 * 60 * 1000)
  if (typeof sweeper.unref === 'function') sweeper.unref()

  return () => {
    clearInterval(sweeper)
    for (const dispose of registrations) {
      try { dispose?.() } catch { /* 已经没了 */ }
    }
  }
}
