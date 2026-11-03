// lib/jmcomic.js — 与 jmcomic（hect0x7/JMComic-Crawler-Python）的桥。
//
// 这一层只做四件事：找 Python、探依赖、跑安装、跑下载。判断「下载成功还是失败」
// 的重活也在这里，因为 jmcomic 的一个大坑是**失败时退出码仍是 0**——
// 光看 code 会把「本子号不存在」当成下载完成。
//
// 与「漫画下载」QQ 桥接插件的 src/jmcomic.js 同源，改造点：不再写死 exe 路径，
// 改成可探测（配置 → DSH 自带 → 常见安装位置 → PATH）；日志回调用 onLog 逐行上报。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

/** 判定某个 exe 是不是 Python 启动器（python.exe / python3 / py / pythonw.exe 都算）。 */
const PY_LAUNCHER_RE = /(^|[\\/])(python|python3|py)(w)?(\.exe)?$/i;

export function isPythonLauncher(exe) {
  return PY_LAUNCHER_RE.test(String(exe ?? ''));
}

/** 探测 python 用的小脚本：只打印版本号，不 import 任何第三方包。 */
const VERSION_PROBE = 'import sys;sys.stdout.write(sys.version.split()[0])';

const probeCache = new Map();

/** 清掉探测缓存（装完包后要重新探一次）。 */
export function clearProbeCache() {
  probeCache.clear();
}

/**
 * 按优先级列出候选 Python。
 *
 * 顺序是「用户自己的环境优先」：用户配置 > Windows 常见安装目录（新版在前）> PATH > DSH 自带运行时。
 *
 * DSH 自带的那个 Python 排在**最后兜底**：它是宿主的私有运行时，往里 pip 装第三方包既不干净、
 * 也活不过 DSH 升级；只有整台机器真的没有别的 Python 时才轮到它。早先把它排在第二位，
 * 结果明明用户自己装了 3.14、jmcomic 也装在 3.14，插件却去挑自带的 3.12——踩过这个坑。
 *
 * PATH 里的 `python` 在 Windows 上常常是 WindowsApps 的空壳别名（点开跳商店），所以排在自带运行时之前、
 * 具体目录之后。
 */
export function candidatePythons(config = {}) {
  const list = [];
  const push = (p, source) => { if (p) list.push({ path: String(p), source }); };

  push(config.pythonPath, 'config');

  const local = process.env.LOCALAPPDATA;
  if (local) {
    // 新版本优先：jmcomic 的硬依赖 commonx / curl-cffi / pillow / pycryptodome 都有 abi3 或 cp314 轮子
    for (const v of ['314', '313', '312', '311', '310']) {
      push(path.join(local, 'Programs', 'Python', `Python${v}`, 'python.exe'), 'localappdata');
    }
  }
  const systemDrive = process.env.SystemDrive || 'C:';
  for (const v of ['314', '313', '312', '311']) {
    push(`${systemDrive}\\Program Files\\Python${v}\\python.exe`, 'programfiles');
  }

  for (const name of ['python', 'python3', 'py']) push(name, 'PATH');

  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  push(path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'), 'dsh-bundled');

  // 去重（保留第一次出现的 priority）
  const seen = new Set();
  return list.filter((item) => {
    const key = process.platform === 'win32' ? item.path.toLowerCase() : item.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 探测一个 python 能不能跑。结果按路径缓存（同一个 exe 不重复起进程）。 */
export function probePython(exe, timeoutMs = 15000) {
  const key = String(exe);
  const cached = probeCache.get(key);
  if (cached) return cached;

  const result = spawnSync(exe, ['-c', VERSION_PROBE], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
  });

  let value;
  if (result.error) {
    value = { ok: false, path: key, version: '', error: String(result.error.message ?? result.error).slice(0, 200) };
  } else if (result.status !== 0) {
    const text = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim() || `退出码 ${result.status}`;
    value = { ok: false, path: key, version: '', error: text.slice(0, 200) };
  } else {
    value = { ok: true, path: key, version: String(result.stdout ?? '').trim(), error: '' };
  }
  probeCache.set(key, value);
  return value;
}

/**
 * 找第一个能跑的 Python；**装了 moduleName 的那个优先**。
 *
 * 只按路径顺序挑是不够的：用户可能装了三个 Python，jmcomic 只装在其中一个。所以先挑一个能跑的，
 * 再在能跑的里面找装过依赖的那个，都没有才退回「第一个能跑的」（这时返回 hasModule:false，
 * 调用方据此提示先跑 comic_setup install）。
 */
export function resolvePython(config = {}, { moduleName = 'jmcomic' } = {}) {
  const usable = [];
  for (const item of candidatePythons(config)) {
    const probe = probePython(item.path);
    if (probe.ok) usable.push({ ...probe, source: item.source });
  }
  if (!usable.length) return null;
  for (const cand of usable) {
    if (detectModule(cand.path, moduleName).ok) return { ...cand, hasModule: true };
  }
  return { ...usable[0], hasModule: false };
}

/** 探测某个 Python 里有没有装某个包。 */
export function detectModule(pythonPath, moduleName, attr = '__version__', timeoutMs = 20000) {
  const safeModule = String(moduleName).replace(/[^A-Za-z0-9_.]/g, '');
  const safeAttr = String(attr).replace(/[^A-Za-z0-9_]/g, '');
  const script = `import ${safeModule} as m, sys; sys.stdout.write(str(getattr(m, '${safeAttr}', 'ok')))`;
  const result = spawnSync(pythonPath, ['-c', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
  });
  if (result.error || result.status !== 0) {
    const text = `${result.stderr ?? ''}${result.error?.message ?? ''}`.trim() || `退出码 ${result.status}`;
    return { ok: false, version: '', error: text.slice(0, 300) };
  }
  return { ok: true, version: String(result.stdout ?? '').trim(), error: '' };
}

/**
 * 起一个子进程并把 stdout/stderr 逐行收进回调，最后返回完整日志。
 *
 * 三条硬规矩（都是踩出来的）：
 *   1) env 里加 PYTHONIOENCODING=utf-8，**绝不加 PYTHONUTF8=1**——后者会让 libcurl
 *      找不到 cacert.pem，所有请求变成 `curl: (77) error adding trust anchors`；
 *   2) 超时和 AbortSignal 都要能杀进程，否则一个卡死的下载会挂住整轮对话；
 *   3) 日志有上限（默认 200k 字符），jmcomic 的话痨程度足以吃满内存。
 */
export function spawnCapture({
  exe,
  args = [],
  cwd,
  env,
  timeoutMs = 600_000,
  onLog,
  signal,
  maxLogChars = 200_000,
}) {
  return new Promise((resolve, reject) => {
    let log = '';
    let timedOut = false;
    let aborted = false;

    const child = spawn(exe, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(env ?? {}) },
    });

    const append = (chunk) => {
      const text = chunk.toString('utf8');
      if (log.length < maxLogChars) log += text.slice(0, maxLogChars - log.length);
      if (onLog) {
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed !== '') onLog(trimmed);
        }
      }
    };

    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const kill = () => {
      try { child.kill(); } catch { /* 已经退了 */ }
    };

    const timer = Number(timeoutMs) > 0
      ? setTimeout(() => { timedOut = true; kill(); }, Number(timeoutMs))
      : null;
    if (timer && typeof timer.unref === 'function') timer.unref();

    const onAbort = () => { aborted = true; kill(); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    child.on('error', (error) => {
      cleanup();
      reject(new Error(`启动 ${exe} 失败：${String(error?.message ?? error)}`));
    });

    child.on('close', (code) => {
      cleanup();
      resolve({ code, log, timedOut, aborted });
    });
  });
}

/** 装/升级 jmcomic。mirror 为空则用 pip 默认源。 */
export function installJmcomic({ pythonPath, mirror = '', timeoutMs = 900_000, onLog, signal }) {
  const args = ['-m', 'pip', 'install', '-U', 'jmcomic', '--disable-pip-version-check', '--no-input'];
  if (mirror) args.push('-i', mirror);
  return spawnCapture({ exe: pythonPath, args, timeoutMs, onLog, signal });
}

/** 搜索脚本打印结果行用的标记——日志里混进什么都不影响解析。 */
const SEARCH_MARKER = '###RESULT###';

/** 搜索脚本的绝对路径：跟着插件包走，不依赖调用方的 cwd。 */
export function searchScriptPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'jm_search.py');
}

/**
 * 按关键词搜本子，返回带作者与标签的候选列表。
 *
 * 单独起一个 .py 脚本而不是 `-c`：这段逻辑一百来行，塞进命令行会被 Windows 的
 * 引号与编码折腾死；中文关键词走 argv 本身就是 UTF-8，稳。
 */
export async function searchAlbums({ pythonPath, query, limit = 20, timeoutMs = 180_000, signal, onLog }) {
  const result = await spawnCapture({
    exe: pythonPath,
    args: [searchScriptPath(), String(query), String(limit)],
    timeoutMs,
    signal,
    onLog,
    maxLogChars: 80_000,
  });

  if (result.timedOut) throw new Error(`搜索超时（${Math.round(Number(timeoutMs) / 1000)} 秒没跑完）`);
  if (result.aborted) throw new Error('搜索被取消');
  if (result.code !== 0) {
    const tail = String(result.log ?? '').trim().split(/\r?\n/).filter((line) => line !== '').slice(-6).join('\n');
    throw new Error(`搜索脚本退出码 ${result.code}：\n${tail || '（没有输出）'}`);
  }

  const line = String(result.log ?? '')
    .split(/\r?\n/)
    .find((item) => item.includes(SEARCH_MARKER));
  if (!line) throw new Error('搜索没有拿到结果行（脚本可能没跑起来），稍后重试或换个关键词。');

  const payload = line.slice(line.indexOf(SEARCH_MARKER) + SEARCH_MARKER.length).trim();
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new Error(`搜索结果解析失败：${String(error?.message ?? error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('搜索结果格式不对（期望数组）。');
  return parsed;
}

/**
 * 生成一次下载用的 option.yml 内容。
 *
 * base_dir 一律转成正斜杠并用单引号包住：Windows 路径里的反斜杠与盘符冒号
 * 会让 YAML 解析出岔子（`C:\x\y` 里的 `\x` 会被当转义）。
 */
export function renderOptionYaml({
  baseDir,
  proxy = '',
  imageThreads = 8,
  photoThreads = 4,
  decode = true,
}) {
  const quote = (value) => `'${String(value).replace(/\\/g, '/').replace(/'/g, "''")}'`;
  const proxies = [];
  if (proxy) {
    proxies.push(`        http: ${quote(proxy)}`);
    proxies.push(`        https: ${quote(proxy)}`);
  }
  const lines = [
    "version: '2.1'",
    'dir_rule:',
    `  base_dir: ${quote(baseDir)}`,
    "  rule: 'Bd_Aauthor_Atitle_Pindex'",
    'download:',
    '  image:',
    `    decode: ${decode ? 'true' : 'false'}`,
    "    suffix: '.jpg'",
    // threading 必须挂在 download 底下。写成顶层键会被 JmOption(**dic) 当成
    // 构造参数，报 `unexpected keyword argument 'threading'`——yaml 里 version
    // 达到了 JM_OPTION_VER 就会跳过旧版兼容代码，没有别的机会替你搬家。
    '  threading:',
    `    image: ${Number(imageThreads) || 8}`,
    `    photo: ${Number(photoThreads) || 4}`,
    'client:',
    '  impl: api',
    '  retry_times: 3',
    '  postman:',
    '    type: curl_cffi',
    '    meta_data:',
    '      impersonate: chrome',
    proxies.length > 0 ? '      proxies:' : '      proxies: {}',
    ...proxies,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * 跑一次下载。
 *
 * 为什么走 `-c` 而不是 `-m jmcomic`：jmcomic **没有 __main__.py**，
 * `python -m jmcomic` 会报 "No module named jmcomic.__main__"，而它的控制台入口
 * 是 `jmcomic.cli:main`，用 `-c` 直接调最保险（不依赖 Scripts 目录在 PATH 里）。
 */
export function runJmcomic({ pythonPath, album, optionFile, timeoutMs = 600_000, onLog, signal }) {
  const args = isPythonLauncher(pythonPath)
    ? ['-c', 'import sys; from jmcomic.cli import main; main()', String(album), '--option', optionFile, '--no-progress']
    : [String(album), '--option', optionFile, '--no-progress'];
  return spawnCapture({ exe: pythonPath, args, timeoutMs, onLog, signal });
}

/**
 * jmcomic 失败时退出码仍然是 0，只能从日志里认异常名。
 * 扫的是 `jmcomic.jm_exception.XXX` 这种带完整模块路径的写法。
 */
const FATAL_RE = /jmcomic\.jm_exception\.([A-Za-z_]+)/;

export function detectFatal(log) {
  const hit = FATAL_RE.exec(String(log ?? ''));
  return hit ? hit[1] : '';
}

const FAILURE_HINTS = {
  MissingAlbumPhoto: '本子号不存在、或该作品已下架；先核对号对不对。',
  AlbumNotFound: '本子号不存在、或该作品已下架；先核对号对不对。',
  RequestExceptionCover: '这个作品看不了（可能已下架或需要权限）。',
  NeedLogin: '这是需要登录/会员的内容，jmcomic 匿名下不了。',
  NeedVip: '这是需要 VIP 的内容，jmcomic 匿名下不了。',
  ApiFailed: '接口返回失败——多半是网络/代理问题，或触发了站点限流，稍后重试。',
  ConnectionError: '连不上站点——检查网络或代理配置。',
  SSLError: 'TLS 握手失败——常见于代理劫持或证书问题。',
};

/** 把异常名 + 日志尾巴翻译成一条可读的失败原因。 */
export function explainFailure(exceptionName, log) {
  const name = String(exceptionName ?? '');
  if (name && FAILURE_HINTS[name]) return `${name}：${FAILURE_HINTS[name]}`;
  const tail = String(log ?? '').trim().split(/\r?\n/).filter((line) => line !== '').slice(-6).join('\n');
  if (name) return `${name}：${tail || '（没有更多输出）'}`;
  return tail || '没有输出，无法判断原因';
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif']);

/** 数字感知的自然排序：2.jpg 排在 10.jpg 前面。 */
export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), 'zh-CN', { numeric: true, sensitivity: 'base' });
}

/**
 * 递归收集「装着图片的目录」，每个目录一组（一组 = 一本 PDF）。
 *
 * 为什么要分组而不是全递归拼一份：jmcomic 的目录结构是 作者/标题/章节/页码，
 * 一个作品可能有很多话；不分组的后果是把十话拼成一本两千页的 PDF。
 */
export function collectImageDirs(root) {
  const groups = [];
  const walk = (dir, depth = 0) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const images = [];
    const subdirs = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) subdirs.push(full);
      else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) images.push(full);
    }
    if (images.length > 0) {
      images.sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));
      groups.push({ dir, images });
    }
    for (const sub of subdirs) walk(sub, depth + 1);
  };
  walk(root);
  return groups;
}

/**
 * 给一组图片目录起个像样的 PDF 名。
 *
 * jmcomic 的目录是 `作者/标题/章节号/页码.jpg`（dir_rule = Bd_Aauthor_Atitle_Pindex），
 * 所以一组图片所在的目录名往往就是那个「章节号」（1、2、3…）——直接拿它当 PDF 名，
 * 下十本会得到十个第一章都叫 1.pdf。这里沿路径往回找**最后一个非纯数字的片段**，
 * 那才是作品标题；全都数字（比如用户自己按序号分的目录）就退回数字拼接。
 *
 * @param {string} dir 装着图片的那个目录
 * @param {string} root 起名的参照根（通常就是这本书的目录）
 */
export function pdfNameForGroup(dir, root) {
  const rel = path.relative(root, dir);
  const parts = rel.split(/[\\/]+/).filter((s) => s !== '' && s !== '.' && s !== '..');
  if (parts.length === 0) return path.basename(root) || 'comic';
  const words = parts.filter((s) => !/^\d+$/.test(s));
  const nums = parts.filter((s) => /^\d+$/.test(s));
  if (words.length > 0) return words[words.length - 1];
  return nums.length > 0 ? nums.join('_') : path.basename(dir) || 'comic';
}

/** 默认下载目录：用户 Downloads 下的「漫画」。 */
export function defaultOutDir() {
  const home = os.homedir();
  return path.join(home, 'Downloads', '漫画');
}

/** 建目录（已存在不报错）。 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 目录里有多少个图片文件（粗略统计，用于 status 展示）。 */
export function countImages(root) {
  let total = 0;
  for (const group of collectImageDirs(root)) total += group.images.length;
  return total;
}
