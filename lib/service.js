// lib/service.js — dsh-comic 的业务核心：环境自检、装依赖、下载、转 PDF、列已下载。
//
// 工具层（lib/tool.js）只负责参数与渲染，真正的活都在这里，方便单测直接调。
//
// 一条贯穿全篇的原则：**不假装成功**。jmcomic 失败时退出码是 0，PDF 写完也可能是
// 半截文件，所以每一步结束都拿证据说话（异常名、磁盘上的字节、xref 校验）。
import fs from 'node:fs';
import path from 'node:path';
import {
  candidatePythons,
  clearProbeCache,
  collectImageDirs,
  defaultOutDir,
  detectFatal,
  detectModule,
  ensureDir,
  explainFailure,
  installJmcomic,
  naturalCompare,
  pdfNameForGroup,
  probePython,
  renderOptionYaml,
  resolvePython,
  runJmcomic,
  searchAlbums,
} from './jmcomic.js';
import { buildComicPdf, verifyComicPdf } from './pdf.js';

/** Windows 文件名非法字符（外加控制字符与保留的设备名冲突风险）。 */
function sanitizeName(name) {
  const cleaned = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned === '' ? 'comic' : cleaned.slice(0, 120);
}

/** 日志只留最后 N 行——送回给模型的必须是能一眼看完的尾巴。 */
function tailOf(log, lines = 40) {
  return String(log ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .slice(-lines)
    .join('\n');
}

const ALBUM_RE = /^[0-9A-Za-z][0-9A-Za-z,_-]{0,63}$/;

/** 下载中转目录：成品只留 PDF，原图与中间结构都活在这里，跑完就删。 */
const TEMP_DIR_NAME = '.dsh-comic-tmp';

/** keepImages=true 时原图的去处（隐藏目录，不混进成片区）。 */
const IMAGES_DIR_NAME = '.images';

export function normalizeAlbum(value) {
  const album = String(value ?? '').trim();
  if (!ALBUM_RE.test(album)) {
    throw new Error(`本子号看着不对：「${value}」——只接受数字（或用逗号分隔的多个号），不含空格与特殊字符。`);
  }
  return album;
}

/**
 * 把每组图片复制成成品目录：`<outBase>/<作品名>/`，里面是平铺的图片。
 *
 * 命名与 PDF 用同一套（`pdfNameForGroup`），所以 both 模式下读者看到的是
 * 「同一本书.pdf」和「同一本书/」并排——一眼能认出是一对。
 *
 * @returns {Array<{dir:string,name:string,images:number,bytes:number}>}
 */
export function saveImageDirs({ groups, outBase, root }) {
  const saved = [];
  const taken = new Set();
  for (const group of groups) {
    const base = sanitizeName(pdfNameForGroup(group.dir, root));
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base} (${n})`;
    taken.add(name.toLowerCase());
    const dir = path.join(outBase, name);
    fs.mkdirSync(dir, { recursive: true });
    let bytes = 0;
    for (const file of group.images) {
      const target = path.join(dir, path.basename(file));
      fs.copyFileSync(file, target);
      try { bytes += fs.statSync(target).size; } catch { /* 统计不到不影响成品 */ }
    }
    saved.push({ dir, name, images: group.images.length, bytes });
  }
  return saved;
}

/** 三种成品形态（与 lib/settings.js 的 SAVE_MODES 对齐）。 */
const SAVE_MODES = ['pdf', 'images', 'both'];

/**
 * 这一趟要留什么。
 *
 * `saveMode` 是设置里选的（pdf / images / both）；`keepImages` 是 0.2.x 的老开关，
 * 老配置里它等于 true 的人想要的其实是「PDF 和原图都留」，所以映射到 both。
 */
export function resolveSaveMode(config = {}) {
  const mode = String(config.saveMode ?? '').trim();
  if (SAVE_MODES.includes(mode)) return mode;
  if (config.keepImages === true) return 'both';
  return config.pdf === false ? 'images' : 'pdf';
}

/**
 * 一个插件实例对应的服务对象。
 *
 * @param {object} deps
 * @param {() => object} deps.getConfig 每次调用都取最新配置（配置热改不用重启）
 * @param {object} [deps.logger]
 */
export function createComicService({ getConfig, logger }) {
  const log = (level, message) => {
    const fn = logger?.[level];
    if (typeof fn === 'function') fn.call(logger, message);
  };

  /** 生效的下载目录。 */
  function outDirOf(config) {
    const configured = String(config.outDir ?? '').trim();
    return configured === '' ? defaultOutDir() : path.resolve(configured);
  }

  /** 目录可写性：建一次目录 + 试着写一个临时文件。 */
  function checkWritable(dir) {
    try {
      ensureDir(dir);
      const probe = path.join(dir, `.dsh-comic-write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      return { ok: true, error: '' };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 300) };
    }
  }

  /**
   * 全量环境自检。
   *
   * 这里故意把所有候选 Python 都探一遍（而不只报第一个失败的），
   * 因为「装不上」最常见的根因是**选错了 Python**（比如 PATH 里那个假 python）。
   */
  function status() {
    const config = getConfig();
    const outDir = outDirOf(config);
    const writable = checkWritable(outDir);

    const candidates = candidatePythons(config).map((item) => {
      const probe = probePython(item.path);
      return {
        path: probe.path,
        source: item.source,
        ok: probe.ok,
        version: probe.version,
        error: probe.error,
      };
    });

    const python = resolvePython(config);
    let jmcomic = { ok: false, version: '', error: '没有可用的 Python' };
    let pillow = { ok: false, version: '', error: '没有可用的 Python' };
    if (python) {
      jmcomic = detectModule(python.path, 'jmcomic');
      pillow = detectModule(python.path, 'PIL');
    }

    return {
      outDir,
      outDirWritable: writable.ok,
      outDirError: writable.error,
      python: python
        ? { ok: true, path: python.path, version: python.version, source: python.source, error: '' }
        : { ok: false, path: '', version: '', source: '', error: '没找到能跑的 Python（可在配置里用 pythonPath 指定全路径）' },
      jmcomic,
      pillow,
      candidates,
      ready: Boolean(python) && jmcomic.ok,
      config: {
        saveMode: resolveSaveMode(config),
        proxy: String(config.proxy ?? ''),
        pythonMirror: String(config.pythonMirror ?? ''),
        imageThreads: Number(config.imageThreads) || 8,
        photoThreads: Number(config.photoThreads) || 4,
        timeoutMs: Number(config.timeoutMs) || 600_000,
      },
    };
  }

  /** 装/升级 jmcomic。装完要清探测缓存，否则 detectModule 还是旧答案。 */
  async function install({ signal } = {}) {
    const config = getConfig();
    const python = resolvePython(config);
    if (!python) {
      throw new Error('没找到能跑的 Python。先装一个 Python 3.11–3.14，或在配置里用 pythonPath 指定全路径。');
    }
    const mirror = String(config.pythonMirror ?? '').trim();
    log('info', `[dsh-comic] 安装 jmcomic：${python.path}${mirror ? `（镜像 ${mirror}）` : ''}`);
    const result = await installJmcomic({
      pythonPath: python.path,
      mirror,
      timeoutMs: Number(config.installTimeoutMs) || 900_000,
      signal,
    });
    clearProbeCache();
    const after = detectModule(python.path, 'jmcomic');
    return {
      ok: after.ok && !result.timedOut && !result.aborted,
      pythonPath: python.path,
      exitCode: result.code,
      timedOut: Boolean(result.timedOut),
      aborted: Boolean(result.aborted),
      version: after.version,
      error: after.ok ? '' : (after.error || '安装结束但 import 不进来').slice(0, 400),
      logTail: tailOf(result.log, 30),
    };
  }

  /**
   * 把一组图片目录转成 PDF。
   *
   * @returns {Promise<Array<{file:string,pages:number,bytes:number,engine:string,verified:boolean,problems:string[]}>>}
   */
  async function convertDirs({ groups, outBase, root, pythonPath, titleFor, signal }) {
    const config = getConfig();
    const outputs = [];
    const taken = new Set();
    for (const group of groups) {
      if (signal?.aborted) break;
      // 名字取自「作品标题」而不是图片所在的目录名——那层目录往往只是章节号，
      // 全书都叫 1、2、3。重名时依次加 (2)(3)，保证同一本书里不互相覆盖。
      const base = sanitizeName(pdfNameForGroup(group.dir, root));
      let name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base} (${n})`;
      taken.add(name.toLowerCase());
      const file = path.join(outBase, `${name}.pdf`);
      const built = await buildComicPdf({
        images: group.images,
        outPath: file,
        title: titleFor ? titleFor(group, name) : name,
        pythonPath,
        timeoutMs: Math.min(Number(config.timeoutMs) || 600_000, 900_000),
      });
      const verified = verifyComicPdf({ file, expectPages: group.images.length });
      outputs.push({
        file,
        pages: built.pages,
        bytes: built.bytes,
        engine: built.engine,
        verified: verified.ok,
        problems: verified.problems,
      });
    }
    return outputs;
  }

  /**
   * 下载一个本子，并在同一趟里把它转成 PDF。
   *
   * 目录约定：**成品目录是平的**——`<outDir>/<标题>.pdf`，不留本子号目录、不留原图。
   * 所以下载先落在 `<outDir>/.dsh-comic-tmp/<本子号>/` 这个临时目录里（jmcomic 的
   * 作者/标题/章节结构照旧），拼完 PDF 再把整棵临时树删掉。中途失败也删——
   * 半本的图没有留存价值，下次重下比对比着残骸续传省事。
   *
   * 唯一例外：配置里 keepImages=true 时把原图挪进 `<outDir>/.images/<本子号>/`（隐藏目录，
   * 不碍眼也不混进成片区）。
   */
  async function download({ album: rawAlbum, outDir: rawOutDir, pdf: rawPdf, saveMode: rawSaveMode, signal, onProgress } = {}) {
    const config = getConfig();
    const album = normalizeAlbum(rawAlbum);
    const python = resolvePython(config);
    if (!python) {
      throw new Error('没找到能跑的 Python。先 `comic_setup action=status` 看环境，或装一个 Python 3.11–3.14 并在配置里指定 pythonPath。');
    }
    const jmcomic = detectModule(python.path, 'jmcomic');
    if (!jmcomic.ok) {
      throw new Error(`这个 Python（${python.path}）里没有 jmcomic。先跑 \`comic_setup action=install\` 装上（或换一个已装好的 Python）。`);
    }

    const baseOutDir = ensureDir(String(rawOutDir ?? '').trim() === '' ? outDirOf(config) : path.resolve(String(rawOutDir)));
    const workRoot = path.join(baseOutDir, TEMP_DIR_NAME);
    const albumDir = ensureDir(path.join(workRoot, sanitizeName(album)));
    const optionFile = path.join(albumDir, '.dsh-option.yml');
    fs.writeFileSync(optionFile, renderOptionYaml({
      baseDir: albumDir,
      proxy: String(config.proxy ?? ''),
      imageThreads: Number(config.imageThreads) || 8,
      photoThreads: Number(config.photoThreads) || 4,
      decode: true,
    }), 'utf8');

    /**
     * 清掉临时下载树。
     *
     * 留下来的图片成品是复制出去的，所以这里一律删——不再有「把原树挪进 .images」
     * 那一步（0.2.x 的 keepImages 现在映射成 saveMode='both'，图另有去处）。
     */
    const cleanupWork = () => {
      try { fs.rmSync(albumDir, { recursive: true, force: true }); } catch { /* 删不掉不是致命错 */ }
      // 临时根目录空了就一起收掉（有别的下载在并行时它不空，那就留着）
      try {
        if (fs.readdirSync(workRoot).length === 0) fs.rmdirSync(workRoot);
      } catch { /* 不在、不空、被占用都无所谓 */ }
    };

    const startedAt = Date.now();
    const progressLines = [];
    const result = await runJmcomic({
      pythonPath: python.path,
      album,
      optionFile,
      timeoutMs: Number(config.timeoutMs) || 600_000,
      signal,
      onLog: (line) => {
        progressLines.push(line);
        if (progressLines.length > 400) progressLines.shift();
        if (onProgress) onProgress(line);
      },
    });

    const fatal = detectFatal(result.log);
    const failed = result.timedOut || result.aborted || result.code !== 0 || fatal !== '';
    if (failed) {
      const reason = result.aborted
        ? '被取消（用户中止）'
        : result.timedOut
          ? `超时（${Math.round((Number(config.timeoutMs) || 600_000) / 1000)} 秒没跑完）`
          : explainFailure(fatal, result.log);
      cleanupWork();
      return {
        ok: false,
        album,
        root: baseOutDir,
        reason,
        exception: fatal,
        exitCode: result.code,
        durationMs: Date.now() - startedAt,
        logTail: tailOf(result.log, 25),
        pdfs: [],
        images: 0,
      };
    }

    const groups = collectImageDirs(albumDir);
    const imageCount = groups.reduce((sum, group) => sum + group.images.length, 0);
    if (imageCount === 0) {
      cleanupWork();
      return {
        ok: false,
        album,
        root: baseOutDir,
        reason: '下载流程跑完了，但目录里一张图都没有——检查日志（可能是站点改版或号不对）。',
        exception: fatal,
        exitCode: result.code,
        durationMs: Date.now() - startedAt,
        logTail: tailOf(result.log, 25),
        pdfs: [],
        images: 0,
      };
    }

    const requested = String(rawSaveMode ?? '').trim();
    const saveMode = SAVE_MODES.includes(requested) ? requested : resolveSaveMode(config);
    const wantPdf = saveMode !== 'images' && (rawPdf === undefined ? config.pdf !== false : rawPdf === true);
    const wantImages = saveMode !== 'pdf';
    // PDF 直接吐进 baseOutDir（平铺），命名以 albumDir 为根——那才是「作者/标题/章节」这套结构。
    const pdfs = wantPdf
      ? await convertDirs({
        groups,
        outBase: baseOutDir,
        root: albumDir,
        pythonPath: python.path,
        signal,
        titleFor: (_group, name) => name,
      })
      : [];

    // 图片成品：复制成 `<outDir>/<作品名>/`，与 PDF 同名并列。复制而不是搬运原树，
    // 是为了不把 jmcomic 那套「作者/标题/章节」的层级带进成品目录。
    const imageDirs = wantImages ? saveImageDirs({ groups, outBase: baseOutDir, root: albumDir }) : [];

    // 校验没过就不删原图——文件被拼坏时，那些图是唯一的原件。
    // 但已经留了图片成品（images/both）时不必再占中转目录，直接清掉。
    const allVerified = wantPdf ? pdfs.length > 0 && pdfs.every((item) => item.verified) : true;
    const keepWork = wantPdf && !allVerified && imageDirs.length === 0;
    if (keepWork) {
      log('warn', '[dsh-comic] PDF 校验未全部通过，原图保留在临时目录');
    } else {
      cleanupWork();
    }

    log('info', `[dsh-comic] ${album} 下载完成：${imageCount} 张图 / ${pdfs.length} 本 PDF / ${imageDirs.length} 个图片文件夹`);
    return {
      ok: true,
      album,
      saveMode,
      root: keepWork ? albumDir : baseOutDir,
      reason: '',
      exception: '',
      exitCode: result.code,
      durationMs: Date.now() - startedAt,
      logTail: tailOf(result.log, 25),
      pdfs,
      imageDirs,
      images: imageCount,
    };
  }

  /** 把任意一个已经装着图片的目录转成 PDF（不下载）。 */
  async function convert({ dir: rawDir, outDir: rawOutDir, signal } = {}) {
    const config = getConfig();
    const source = path.resolve(String(rawDir ?? '').trim());
    if (!fs.existsSync(source)) throw new Error(`目录不存在：${source}`);
    const stat = fs.statSync(source);
    if (!stat.isDirectory()) throw new Error(`不是目录：${source}`);

    const groups = collectImageDirs(source);
    if (groups.length === 0) throw new Error(`这个目录里没找到图片（支持 jpg/jpeg/png/webp/bmp/gif/avif）：${source}`);

    const python = resolvePython(config);
    const outBase = String(rawOutDir ?? '').trim() === '' ? source : ensureDir(path.resolve(String(rawOutDir)));
    const startedAt = Date.now();
    const pdfs = await convertDirs({
      groups,
      outBase,
      root: source,
      pythonPath: python?.path ?? '',
      signal,
      titleFor: (_group, name) => name,
    });
    return {
      ok: pdfs.every((item) => item.verified),
      source,
      outDir: outBase,
      images: groups.reduce((sum, group) => sum + group.images.length, 0),
      pdfs,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * 按关键词搜本子。搜索结果通常不止一本（把一本杂志里的单篇也算一条），
   * 所以这里把作者、标签、页数一并带出去，让用户能挑——只给个号是没法挑的。
   */
  async function search({ query: rawQuery, limit = 20, signal } = {}) {
    const config = getConfig();
    const query = String(rawQuery ?? '').trim();
    if (query === '') throw new Error('search 需要 query（作品名，中文/日文都行）。');

    const python = resolvePython(config);
    if (!python) {
      throw new Error('没找到能跑的 Python。先 `comic_setup action=status` 看环境，或在配置里指定 pythonPath。');
    }
    if (!detectModule(python.path, 'jmcomic').ok) {
      throw new Error(`这个 Python（${python.path}）里没有 jmcomic。先跑 \`comic_setup action=install\` 装上。`);
    }

    const startedAt = Date.now();
    const capped = Math.max(1, Math.min(50, Number(limit) || 20));
    const raw = await searchAlbums({
      pythonPath: python.path,
      query,
      limit: capped,
      timeoutMs: 180_000,
      signal,
    });

    const items = raw.map((item, index) => ({
      index: index + 1,
      album: String(item.album_id ?? ''),
      title: String(item.title ?? '').trim(),
      authors: Array.isArray(item.authors) ? item.authors.map(String) : [],
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      works: Array.isArray(item.works) ? item.works.map(String) : [],
      pageCount: Number(item.page_count) || 0,
      pubDate: String(item.pub_date ?? ''),
      views: String(item.views ?? ''),
      cover: String(item.cover ?? ''),
      description: String(item.description ?? ''),
      note: String(item.error ?? ''),
    }));

    return {
      ok: true,
      query,
      count: items.length,
      items,
      durationMs: Date.now() - startedAt,
    };
  }

  /** 看一眼成品目录里有什么（平铺的 PDF 与图片文件夹）。老版本留下的子目录也照列，不当它们不存在。 */
  function list({ limit = 50 } = {}) {
    const config = getConfig();
    const outDir = outDirOf(config);
    let entries = [];
    try {
      entries = fs.readdirSync(outDir, { withFileTypes: true });
    } catch {
      return { outDir, exists: false, count: 0, items: [] };
    }

    const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif']);
    const items = [];
    const pushFile = (file, name) => {
      let bytes = 0;
      let mtime = 0;
      try {
        const stat = fs.statSync(file);
        bytes = stat.size;
        mtime = stat.mtimeMs;
      } catch { /* 读不到就当 0 */ }
      items.push({ kind: 'pdf', name, file, bytes, modifiedMs: mtime, images: 0, cover: '' });
    };

    /** 直接放着图片的目录 = 图片成品；返回封面与张数。 */
    const asImageDir = (dir) => {
      let children = [];
      try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
      const images = children
        .filter((child) => child.isFile() && IMAGE_EXT.has(path.extname(child.name).toLowerCase()))
        .map((child) => child.name)
        .sort(naturalCompare);
      if (images.length === 0) return null;
      let mtime = 0;
      let bytes = 0;
      for (const name of images) {
        try {
          const stat = fs.statSync(path.join(dir, name));
          bytes += stat.size;
          mtime = Math.max(mtime, stat.mtimeMs);
        } catch { /* 单张读不到不影响整组 */ }
      }
      return { images, cover: path.join(dir, images[0]), bytes, modifiedMs: mtime };
    };

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        if (path.extname(entry.name).toLowerCase() === '.pdf') pushFile(path.join(outDir, entry.name), entry.name);
        continue;
      }
      if (entry.name === TEMP_DIR_NAME || entry.name === IMAGES_DIR_NAME) continue;
      const dir = path.join(outDir, entry.name);
      const imageDir = asImageDir(dir);
      if (imageDir) {
        items.push({
          kind: 'dir',
          name: entry.name,
          file: dir,
          bytes: imageDir.bytes,
          modifiedMs: imageDir.modifiedMs,
          images: imageDir.images.length,
          cover: imageDir.cover,
        });
        continue;
      }
      // 旧结构（<本子号>/…/*.pdf）与别的目录：下钻找 PDF，别让老文件从列表里消失
      const scan = (current, depth) => {
        if (depth > 4) return;
        let children = [];
        try { children = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
        for (const child of children) {
          const full = path.join(current, child.name);
          if (child.isDirectory()) scan(full, depth + 1);
          else if (path.extname(child.name).toLowerCase() === '.pdf') pushFile(full, child.name);
        }
      };
      scan(dir, 0);
    }

    items.sort((a, b) => b.modifiedMs - a.modifiedMs || naturalCompare(a.name, b.name));
    return {
      outDir,
      exists: true,
      count: items.length,
      items: items.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))),
    };
  }

  return { status, install, download, convert, list, search, outDirOf, outDir: () => outDirOf(getConfig()) };
}
