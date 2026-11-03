/**
 * dsh-comic — 界面（Client 半边）。
 *
 * 加载方式与 dsh-meme / dsh-ssh 同款：window.__ModuleLoader__.load + require('react')，
 * 不用打包、不用构建，宿主按 package.json 的 dsh.client 把它当浏览器模块发出去。
 *
 * 三个入口（设置里三选一，默认「关闭」）：
 *   - off      ：什么都不注册
 *   - sidebar  ：侧栏脚部（设置旁边）多一个按钮
 *   - floating ：右下角一个 JM 悬浮图标
 * 另有「设置」入口两个：插件设置页里的一个 tab，以及插件自己那张卡片上的配置区。
 *
 * 数据全走宿主 HTTP 接口 /api/dsh-comic/*：搜索、下载、作业轮询、设置、封面代理。
 */
window.__ModuleLoader__.load({
  id: 'dsh-comic',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const API = '/api/dsh-comic'

    // ---------------------------------------------------------------- 样式
    const CSS = [
      '.dcomic-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;transition:background .12s ease,border-color .12s ease;white-space:nowrap}',
      '.dcomic-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dcomic-btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.dcomic-btn.primary:hover{filter:brightness(1.06)}',
      '.dcomic-btn:disabled{opacity:.55;cursor:default}',
      '.dcomic-float{position:fixed;right:22px;bottom:26px;width:48px;height:48px;border-radius:14px;border:none;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 22px rgba(0,0,0,.28);transition:transform .14s ease;z-index:60;overflow:hidden}',
      '.dcomic-float:hover{transform:translateY(-2px)}',
      '.dcomic-mask{position:fixed;inset:0;background:rgba(0,0,0,.42);z-index:80;display:flex;align-items:center;justify-content:center;padding:24px}',
      '.dcomic-box{width:min(880px,94vw);max-height:86vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden}',
      '.dcomic-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dcomic-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:8px}',
      '.dcomic-body{padding:14px 16px 18px;overflow:auto;display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dcomic-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dcomic-input{flex:1;min-width:180px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 11px;font-size:13px;outline:none}',
      '.dcomic-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dcomic-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dcomic-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}',
      '.dcomic-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column}',
      '.dcomic-card:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.dcomic-cover{width:100%;aspect-ratio:3/4;object-fit:cover;background:var(--dsw-alias-bg-layer-1);display:block}',
      '.dcomic-cover-wrap{position:relative}',
      '.dcomic-idx{position:absolute;left:6px;top:6px;background:rgba(0,0,0,.62);color:#fff;font-size:11px;padding:2px 7px;border-radius:999px}',
      '.dcomic-card-body{padding:8px 10px 10px;display:flex;flex-direction:column;gap:6px;flex:1}',
      '.dcomic-card-title{font-size:12px;line-height:1.45;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
      '.dcomic-tags{display:flex;flex-wrap:wrap;gap:4px}',
      '.dcomic-tag{font-size:10px;padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-label-secondary)}',
      '.dcomic-meta{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.dcomic-err{color:#e5484d;font-size:12px;line-height:1.6;white-space:pre-wrap}',
      '.dcomic-ok{color:#2f9e44;font-size:12px;line-height:1.6;word-break:break-all}',
      '.dcomic-spin{width:14px;height:14px;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;display:inline-block;animation:dcomic-rot .8s linear infinite}',
      '@keyframes dcomic-rot{to{transform:rotate(360deg)}}',
      '.dcomic-set{display:flex;flex-direction:column;gap:14px;padding:4px 0;font-size:13px}',
      '.dcomic-set-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.03em}',
      '.dcomic-radio{display:flex;flex-direction:column;gap:8px}',
      '.dcomic-radio label{display:flex;align-items:flex-start;gap:8px;cursor:pointer;line-height:1.5}',
      '.dcomic-radio input{margin-top:3px}',
      '.dcomic-sep{height:1px;background:var(--dsw-alias-border-l1)}',
      '.dcomic-log{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;max-height:96px;overflow:auto}',
      '.dcomic-product{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2)}',
      '.dcomic-product-name{font-size:12px;line-height:1.5;word-break:break-all;flex:1}',
      '.dcomic-viewer{display:flex;flex-direction:column;gap:10px}',
      '.dcomic-pdf{width:100%;height:64vh;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:#fff}',
      '.dcomic-big{max-width:100%;max-height:56vh;object-fit:contain;display:block;margin:0 auto;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.dcomic-thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:8px;max-height:34vh;overflow:auto;padding:2px}',
      '.dcomic-thumb{width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
      '.dcomic-thumb.on{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary)}',
    ].join('')

    function useStyle(text, name) {
      const el = useRef(null)
      useEffect(() => {
        el.current = document.createElement('style')
        el.current.dataset.dcomic = name
        el.current.textContent = text
        document.head.appendChild(el.current)
        return () => { try { el.current?.remove() } catch { /* ignore */ } }
      }, [])
    }

    // ------------------------------------------------------------ 极简 store
    function makeStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set: (patch) => {
          value = { ...value, ...patch }
          for (const fn of listeners) fn()
        },
        subscribe: (fn) => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
      }
    }

    function useStore(store) {
      const [, force] = useState(0)
      useEffect(() => store.subscribe(() => force((n) => n + 1)), [store])
      return store.get()
    }

    const ui = makeStore({ open: false })
    const settingsStore = makeStore({ entryMode: 'floating', downloadDir: '', directToFolder: true, saveMode: 'pdf', loaded: false })

    async function apiJson(path, init) {
      const res = await fetch(API + path, init)
      const text = await res.text()
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { throw new Error(`接口返回的不是 JSON：${text.slice(0, 200)}`) }
      if (!res.ok || (data && data.ok === false)) throw new Error((data && data.error) || `HTTP ${res.status}`)
      return data
    }

    function loadSettings() {
      return apiJson('/settings')
        .then((data) => settingsStore.set({ ...data.settings, loaded: true }))
        .catch(() => settingsStore.set({ loaded: true }))
    }

    function saveSettings(patch) {
      settingsStore.set(patch)
      return apiJson('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).then((data) => settingsStore.set(data.settings)).catch(() => { /* 存不上就先本地生效 */ })
    }

    /** 下载前定目的地：勾了「直接下载至设置文件夹」就用设置的目录，否则弹目录选择框。 */
    async function resolveOutDir(ctx) {
      const now = settingsStore.get()
      if (now.directToFolder && now.downloadDir) return now.downloadDir
      const ws = ctx.get('uiWorkspace')
      if (ws && typeof ws.pickDirectory === 'function') {
        const picked = await ws.pickDirectory()
        if (!picked) throw new Error('已取消：没有选择下载文件夹')
        return picked
      }
      if (now.downloadDir) return now.downloadDir
      throw new Error('没有可用的下载目录：请在设置里填一个，或勾选「直接下载至设置文件夹」')
    }

    function startDownload(ctx, album) {
      return resolveOutDir(ctx).then((outDir) => apiJson('/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ album, outDir }),
      }))
    }

    // ---------------------------------------------------------- JM 图标
    // 画一个自己的「JM」字标（圆角方块 + 双字母），不去抓站点的商标图。
    function JmIcon(size) {
      return h('svg', {
        width: size || 30, height: size || 30, viewBox: '0 0 48 48', 'aria-hidden': 'true',
      },
      h('defs', null,
        h('linearGradient', { id: 'dcomic-g', x1: '0', y1: '0', x2: '1', y2: '1' },
          h('stop', { offset: '0%', stopColor: '#7a3cff' }),
          h('stop', { offset: '100%', stopColor: '#ff4fa3' }))),
      h('rect', { x: 1, y: 1, width: 46, height: 46, rx: 12, fill: 'url(#dcomic-g)' }),
      h('text', {
        x: 24, y: 31, textAnchor: 'middle', fontFamily: 'Arial Black, Arial, sans-serif',
        fontSize: 19, fontWeight: '900', fill: '#fff', letterSpacing: '-1',
      }, 'JM'))
    }

    // ------------------------------------------------------- 设置面板
    // 注意：槽位渲染函数拿到的是 props，ctx 在 props.ctx 里。
    function SettingsPanel(props) {
      const ctx = (props && props.ctx) || {}
      useStyle(CSS, 'comic-settings')
      const s = useStore(settingsStore)
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        if (!settingsStore.get().loaded) loadSettings()
      }, [])

      const pick = () => {
        const ws = ctx.get('uiWorkspace')
        if (!ws || typeof ws.pickDirectory !== 'function') return
        setBusy(true)
        ws.pickDirectory()
          .then((dir) => { if (dir) return saveSettings({ downloadDir: dir }) })
          .catch(() => {})
          .finally(() => setBusy(false))
      }

      // 界面上只给这两种——「关闭」一选就再没有入口能回来（设置页这个 profile 挂不出来），
      // 所以不摆这个选项；真要关，改 <DSH_HOME>/data/dsh-comic/settings.json 的 entryMode。
      const modes = [
        ['floating', '悬浮图标', '右下角一个 JM 圆按钮，点开就是搜索框（默认）'],
        ['sidebar', '添加至侧栏', '在左侧栏底部加一个「漫画」按钮'],
      ]

      // 成品形态三选一（作者 2026-11-02 定）。PDF 与原图文件夹同名并排，一眼能认出一对。
      const saveModes = [
        ['pdf', 'PDF（原图删掉）', '拼成一本 PDF，原图下完即删——目录里只有一本书'],
        ['images', '只要图片', '不拼 PDF，图片按作品名进同名文件夹'],
        ['both', 'PDF + 图片', '两个都留：同一本书.pdf 与同名文件夹并排'],
      ]

      return h('div', { className: 'dcomic-set' },
        h('div', { className: 'dcomic-set-title' }, '界面入口'),
        h('div', { className: 'dcomic-radio' },
          modes.map(([value, label, hint]) => h('label', { key: value },
            h('input', {
              type: 'radio',
              name: 'dcomic-entry',
              checked: s.entryMode === value,
              onChange: () => saveSettings({ entryMode: value }),
            }),
            h('span', null,
              h('div', null, label),
              h('div', { className: 'dcomic-hint' }, hint))))),
        h('div', { className: 'dcomic-sep' }),
        h('div', { className: 'dcomic-set-title' }, '下载成品'),
        h('div', { className: 'dcomic-radio' },
          saveModes.map(([value, label, hint]) => h('label', { key: value },
            h('input', {
              type: 'radio',
              name: 'dcomic-save',
              checked: (s.saveMode || 'pdf') === value,
              onChange: () => saveSettings({ saveMode: value }),
            }),
            h('span', null,
              h('div', null, label),
              h('div', { className: 'dcomic-hint' }, hint))))),
        h('div', { className: 'dcomic-sep' }),
        h('div', { className: 'dcomic-set-title' }, '下载文件夹'),
        h('div', { className: 'dcomic-row' },
          h('input', {
            className: 'dcomic-input',
            type: 'text',
            placeholder: '留空 = 用插件配置里的 outDir（默认 ~/Downloads/漫画）',
            value: s.downloadDir,
            onChange: (e) => settingsStore.set({ downloadDir: e.target.value }),
            onBlur: (e) => saveSettings({ downloadDir: e.target.value }),
          }),
          h('button', { className: 'dcomic-btn', onClick: pick, disabled: busy }, busy ? '选择中…' : '选择文件夹')),
        h('label', { className: 'dcomic-row', style: { cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: !!s.directToFolder,
            onChange: (e) => saveSettings({ directToFolder: e.target.checked }),
          }),
          h('span', null, '直接下载至设置文件夹'),
          h('span', { className: 'dcomic-hint' }, s.directToFolder ? '（不弹框，直接下）' : '（每次下载前弹框选目录）')),
        h('div', { className: 'dcomic-hint' },
          '改完立刻生效，不用重启。命令行的 comic_fetch 工具不受这里影响（它用自己那套配置）。'),
      )
    }

    // ------------------------------------------------------- 搜索结果卡
    function ResultCard(props) {
      const { item, onPick, disabled } = props
      const cover = item.cover ? `${API}/cover?u=${encodeURIComponent(item.cover)}` : ''
      return h('div', { className: 'dcomic-card' },
        h('div', { className: 'dcomic-cover-wrap' },
          cover
            ? h('img', { className: 'dcomic-cover', src: cover, loading: 'lazy', alt: item.title })
            : h('div', { className: 'dcomic-cover' }),
          h('span', { className: 'dcomic-idx' }, item.album)),
        h('div', { className: 'dcomic-card-body' },
          h('div', { className: 'dcomic-card-title', title: item.title }, item.title),
          h('div', { className: 'dcomic-meta' },
            `${item.authors.length ? item.authors.join('、') : '作者未知'} · ${item.pageCount} 页${item.pubDate ? ` · ${item.pubDate}` : ''}`),
          item.tags.length
            ? h('div', { className: 'dcomic-tags' },
                item.tags.slice(0, 6).map((tag) => h('span', { className: 'dcomic-tag', key: tag }, tag)))
            : null,
          h('button', {
            className: 'dcomic-btn primary',
            style: { marginTop: 'auto' },
            onClick: () => onPick(item),
            disabled,
          }, '下载这本')),
      )
    }

    // ------------------------------------------------------- 查看成品
    function fmtBytes(bytes) {
      const n = Number(bytes) || 0
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
      if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
      return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
    }

    function openNative(p) {
      return apiJson('/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      })
    }

    /**
     * 成品查看器。
     *
     * 为什么不做进右栏：右栏的 tab 由宿主自己的 right Sidebar controller 选
     * （kind 只有 document / files / guide），第三方插件塞不进自己的文档 tab；
     * `layout.openRightbar()` 只开栏、内容仍归它管，硬开会得到一条空栏。
     * 所以查看做在这个面板里——从侧栏/悬浮入口点开，同样是在 dsh 里看。
     */
    function Viewer(props) {
      const { target, onBack } = props
      useStyle(CSS, 'comic-viewer')
      const [files, setFiles] = useState([])
      const [index, setIndex] = useState(0)
      const [error, setError] = useState('')

      useEffect(() => {
        if (!target || target.kind !== 'dir') return
        apiJson(`/dir?p=${encodeURIComponent(target.path)}`)
          .then((data) => setFiles(data.files || []))
          .catch((err) => setError(String(err.message || err)))
      }, [target])

      if (!target) return null

      const fileUrl = (p) => `${API}/file?p=${encodeURIComponent(p)}`

      if (target.kind === 'pdf') {
        return h('div', { className: 'dcomic-viewer' },
          h('div', { className: 'dcomic-row' },
            h('span', { className: 'dcomic-hint' }, `${target.name}${target.pages ? ` · ${target.pages} 页` : ''}`),
            h('button', { className: 'dcomic-btn primary', onClick: () => openNative(target.path).catch((e) => setError(String(e.message || e))) }, '用系统程序打开')),
          error ? h('div', { className: 'dcomic-err' }, error) : null,
          h('iframe', { className: 'dcomic-pdf', src: fileUrl(target.path), title: target.name }),
          h('div', { className: 'dcomic-row' },
            h('button', { className: 'dcomic-btn', onClick: onBack }, '返回')))
      }

      const current = files[index]
      return h('div', { className: 'dcomic-viewer' },
        h('div', { className: 'dcomic-row' },
          h('span', { className: 'dcomic-hint' }, `${target.name} · ${files.length || target.images || 0} 张`),
          h('button', { className: 'dcomic-btn primary', onClick: () => openNative(target.path).catch((e) => setError(String(e.message || e))) }, '打开文件夹')),
        error ? h('div', { className: 'dcomic-err' }, error) : null,
        current
          ? h('img', { className: 'dcomic-big', src: fileUrl(current.path), alt: current.name })
          : h('div', { className: 'dcomic-hint' }, files.length === 0 ? '正在读文件夹……' : '没有图片'),
        h('div', { className: 'dcomic-row' },
          h('button', {
            className: 'dcomic-btn',
            onClick: () => setIndex((i) => Math.max(0, i - 1)),
            disabled: index <= 0,
          }, '上一张'),
          h('span', { className: 'dcomic-hint' }, `${files.length ? index + 1 : 0} / ${files.length}`),
          h('button', {
            className: 'dcomic-btn',
            onClick: () => setIndex((i) => Math.min(files.length - 1, i + 1)),
            disabled: index >= files.length - 1,
          }, '下一张')),
        h('div', { className: 'dcomic-thumbs' },
          files.map((file, i) => h('img', {
            key: file.path,
            className: i === index ? 'dcomic-thumb on' : 'dcomic-thumb',
            src: fileUrl(file.path),
            loading: 'lazy',
            alt: file.name,
            onClick: () => setIndex(i),
          }))),
        h('div', { className: 'dcomic-row' },
          h('button', { className: 'dcomic-btn', onClick: onBack }, '返回')))
    }

    // ------------------------------------------------------- 主界面
    function ComicPanel(props) {
      const { ctx, onClose } = props
      useStyle(CSS, 'comic-panel')
      const [query, setQuery] = useState('')
      const [phase, setPhase] = useState('idle') // idle|searching|results|downloading|done|error
      const [results, setResults] = useState([])
      const [error, setError] = useState('')
      const [job, setJob] = useState(null)
      const [donePath, setDonePath] = useState('')
      const [products, setProducts] = useState([])
      const [view, setView] = useState(null)
      const [showSettings, setShowSettings] = useState(false)
      const poll = useRef(0)

      useEffect(() => {
        if (!settingsStore.get().loaded) loadSettings()
        return () => { if (poll.current) clearInterval(poll.current) }
      }, [])

      const watchJob = useCallback((jobId) => {
        if (poll.current) clearInterval(poll.current)
        poll.current = setInterval(() => {
          apiJson(`/job?id=${encodeURIComponent(jobId)}`)
            .then((data) => {
              setJob(data.job)
              if (data.job.status === 'done') {
                clearInterval(poll.current)
                poll.current = 0
                const result = data.job.result || {}
                const nameOf = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''
                const list = []
                for (const pdf of result.pdfs || []) {
                  list.push({ kind: 'pdf', name: nameOf(pdf.file), path: pdf.file, pages: Number(pdf.pages) || 0, bytes: Number(pdf.bytes) || 0, images: 0 })
                }
                for (const dir of result.imageDirs || []) {
                  list.push({ kind: 'dir', name: dir.name || nameOf(dir.dir), path: dir.dir, pages: 0, bytes: Number(dir.bytes) || 0, images: Number(dir.images) || 0 })
                }
                setProducts(list)
                setDonePath(result.root || '')
                setPhase('done')
              } else if (data.job.status === 'failed') {
                clearInterval(poll.current)
                poll.current = 0
                setError(data.job.error || '下载失败')
                setPhase('error')
              }
            })
            .catch(() => { /* 轮询偶尔断一次不算失败，下一拍再来 */ })
        }, 1500)
      }, [])

      const beginDownload = useCallback((album) => {
        setPhase('downloading')
        setError('')
        setDonePath('')
        startDownload(ctx, album)
          .then((data) => { setJob(data.job); watchJob(data.job.id) })
          .catch((err) => { setError(String(err.message || err)); setPhase('error') })
      }, [ctx, watchJob])

      const doSearch = useCallback(() => {
        const q = query.trim()
        if (!q) return
        setError('')
        setResults([])
        // 纯数字 = 用户直接给了本子号，不用再搜（搜索一次要替每本取详情，很慢）
        if (/^\d{1,12}$/.test(q)) return beginDownload(q)
        setPhase('searching')
        apiJson(`/search?q=${encodeURIComponent(q)}&limit=12`)
          .then((data) => {
            const items = (data.items || []).filter((it) => it.album)
            if (items.length === 0) {
              setError('没搜到。换个写法试试——去掉汉化组名、只留作品名，或改用作者名。')
              setPhase('error')
              return
            }
            if (items.length === 1) {
              setResults(items)
              return beginDownload(items[0].album)
            }
            setResults(items)
            setPhase('results')
          })
          .catch((err) => { setError(String(err.message || err)); setPhase('error') })
      }, [query, beginDownload])

      // 外框：设置还是搜索，只有 body 换，头部与遮罩不变
      const renderShell = (content) => h('div', {
        className: 'dcomic-mask',
        onMouseDown: (e) => { if (e.target === e.currentTarget && onClose) onClose() },
      },
        h('div', { className: 'dcomic-box' },
          h('div', { className: 'dcomic-head' },
            h('div', { className: 'dcomic-title' }, JmIcon(22), '漫画下载'),
            view
              ? h('button', { className: 'dcomic-btn', onClick: () => setView(null) }, '返回')
              : h('button', {
                className: 'dcomic-btn',
                onClick: () => setShowSettings((v) => !v),
              }, showSettings ? '返回' : '设置'),
            h('button', { className: 'dcomic-btn', onClick: onClose }, '关闭')),
          h('div', { className: 'dcomic-body' }, content)))

      const body = []

      if (showSettings) {
        body.push(h(SettingsPanel, { ctx, key: 'settings' }))
        return renderShell(body, true)
      }

      // 查看成品：占满 body，头部换成「返回」
      if (view) {
        body.push(h(Viewer, { key: 'viewer', target: view, onBack: () => setView(null) }))
        return renderShell(body)
      }

      body.push(h('div', { className: 'dcomic-row', key: 'search' },
        h('input', {
          className: 'dcomic-input',
          type: 'text',
          placeholder: '输入 JM 号，或漫画名（中日文都行）',
          value: query,
          autoFocus: true,
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') doSearch() },
        }),
        h('button', {
          className: 'dcomic-btn primary',
          onClick: doSearch,
          disabled: phase === 'searching' || phase === 'downloading',
        }, phase === 'searching' ? '搜索中…' : '搜索')))

      if (phase === 'searching') {
        body.push(h('div', { className: 'dcomic-row', key: 'searching' },
          h('span', { className: 'dcomic-spin' }),
          h('span', { className: 'dcomic-hint' }, '正在搜索……一本一本取详情，十几二十秒是正常的')))
      }

      if (phase === 'downloading') {
        const last = job && job.lines && job.lines.length ? job.lines[job.lines.length - 1] : '正在启动下载……'
        const mode = settingsStore.get().saveMode || 'pdf'
        const tip = mode === 'images' ? '原图会按作品名存进同名文件夹' : (mode === 'both' ? 'PDF 与图片文件夹都会留' : '转成 PDF 后原图会自动删掉，稍等')
        body.push(h('div', { key: 'dl' },
          h('div', { className: 'dcomic-row' },
            h('span', { className: 'dcomic-spin' }),
            h('span', null, `下载中：JM${job ? job.album : ''}`),
            h('span', { className: 'dcomic-hint' }, tip)),
          h('div', { className: 'dcomic-log' }, String(last))))
      }

      if (phase === 'error' && error) {
        body.push(h('div', { className: 'dcomic-err', key: 'err' }, error))
      }

      if (phase === 'done') {
        body.push(h('div', { key: 'done' },
          h('div', { className: 'dcomic-ok' }, '下好了，点「查看」就能看：'),
          products.length === 0
            ? h('div', { className: 'dcomic-hint' }, `成品在 ${donePath || '下载目录'} 里`)
            : products.map((p) => h('div', { className: 'dcomic-product', key: p.path },
              h('div', { className: 'dcomic-product-name' },
                h('div', null, p.name),
                h('div', { className: 'dcomic-hint' },
                  p.kind === 'pdf'
                    ? `PDF · ${p.pages} 页 · ${fmtBytes(p.bytes)}`
                    : `图片 · ${p.images} 张 · ${fmtBytes(p.bytes)}`)),
              h('div', { className: 'dcomic-row' },
                h('button', {
                  className: 'dcomic-btn primary',
                  onClick: () => { setShowSettings(false); setView(p) },
                }, '查看'),
                h('button', {
                  className: 'dcomic-btn',
                  onClick: () => openNative(p.path).catch((e) => { setError(String(e.message || e)); setPhase('error') }),
                }, '用系统打开')))),
          h('div', { className: 'dcomic-row', style: { marginTop: 8 } },
            h('button', {
              className: 'dcomic-btn',
              onClick: () => { setPhase('idle'); setQuery(''); setResults([]); setProducts([]); setView(null) },
            }, '再搜一本'))))
      }

      if (results.length > 1 && (phase === 'results' || phase === 'error')) {
        body.push(h('div', { key: 'hint', className: 'dcomic-hint' }, `搜到 ${results.length} 本，挑一本：`))
        body.push(h('div', { className: 'dcomic-grid', key: 'grid' },
          results.map((item) => h(ResultCard, {
            key: item.album,
            item,
            disabled: phase === 'downloading',
            onPick: (it) => beginDownload(it.album),
          }))))
      } else if (results.length === 1 && phase !== 'done') {
        body.push(h('div', { className: 'dcomic-grid', key: 'grid1' },
          h(ResultCard, { item: results[0], disabled: true, onPick: () => {} })))
      }

      if (phase === 'idle') {
        body.push(h('div', { className: 'dcomic-hint', key: 'tip' },
          '只搜到一个结果会直接开始下载；搜到多本会列全名、作者和标签让你挑。'))
      }

      return renderShell(body)
    }

    // ------------------------------------------------------- 入口组件
    function FloatingButton(props) {
      useStyle(CSS, 'comic-float')
      return h('button', {
        className: 'dcomic-float',
        title: '漫画下载',
        onClick: () => props.open(),
      }, JmIcon(30))
    }

    function SidebarButton(props) {
      useStyle(CSS, 'comic-sidebar')
      return h('button', {
        className: 'dcomic-btn',
        style: { width: '100%', justifyContent: 'flex-start' },
        onClick: () => props.open(),
      }, JmIcon(16), h('span', null, '漫画'))
    }

    // 悬浮层：模态框永远挂在这里，侧栏模式下也能弹在最上面
    function ShellOverlay(props) {
      const state = useStore(ui)
      if (!state.open) return null
      return h(ComicPanel, { ctx: props.ctx, onClose: () => ui.set({ open: false }) })
    }

    // ------------------------------------------------------------ apply
    const inject = ['slots']

    function apply(ctx) {
      // 心跳：先不管成不成，证明「这一半真的在浏览器里跑起来了」。
      // 排查时看 <DSH_HOME>/data/dsh-comic/client-ping.json 有没有新时间戳。
      try { fetch(API + '/ping', { method: 'POST' }).catch(() => {}) } catch { /* ignore */ }

      // dsh-meme 走 ctx.get('slots')，im-connect 走 ctx.slots；两种都兜住。
      const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
      if (!slots) return

      loadSettings()

      // 模态框宿主：与入口形态无关，一直挂着（entryMode=off 时它永远不开）
      const disposeList = []
      const push = (fn) => { if (typeof fn === 'function') disposeList.push(fn) }

      push(slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'dsh-comic-modal', order: 40, label: '漫画下载' },
        () => h(ShellOverlay, { ctx }),
      )))

      // 入口形态随设置变：变了就摘掉旧注册、装新的
      let disposeEntry = null
      const applyEntry = (mode) => {
        if (typeof disposeEntry === 'function') {
          try { disposeEntry() } catch { /* ignore */ }
          disposeEntry = null
        }
        if (mode === 'floating') {
          disposeEntry = slots.inject('shell.overlay', () => slots.register(
            { name: 'shell.overlay', id: 'dsh-comic-float', order: 41, label: '漫画下载' },
            () => h(FloatingButton, { open: () => ui.set({ open: true }) }),
          ))
        } else if (mode === 'sidebar') {
          disposeEntry = slots.inject('sidebar.footer.action', () => slots.register(
            { name: 'sidebar.footer.action', id: 'dsh-comic', order: 20, label: '漫画' },
            () => h(SidebarButton, { open: () => ui.set({ open: true }) }),
          ))
        }
      }

      let lastMode = settingsStore.get().entryMode
      applyEntry(lastMode)
      push(settingsStore.subscribe(() => {
        const mode = settingsStore.get().entryMode
        if (mode !== lastMode) {
          lastMode = mode
          applyEntry(mode)
        }
      }))

      // 设置入口：不再挂 settings.plugins.tab / plugins.bundle.config——这两个槽位在
      // 当前 desktop profile 里挂不出来（ui-settings 那几行是 disabled），挂了也是空的。
      // 改成面板里的「设置」按钮：点悬浮图标 / 侧栏按钮 → 点「设置」就能改。

      ctx.effect(() => () => {
        for (const dispose of disposeList) {
          try { dispose() } catch { /* 已经没了 */ }
        }
      }, 'dsh-comic/client-slots')
    }

    exports.apply = apply
    exports.inject = inject
    // 仅回归测试用，宿主不消费
    exports.__test = { makeStore, JmIcon }
    return module.exports
  },
})
