// lib/tool.js — 给模型用的两个工具：comic_setup（环境）与 comic_fetch（下载/转换）。
//
// 为什么拆成两个：装依赖和下载漫画是两类动作，混在一个 action 枚举里，
// 模型每次选 action 都要在「装东西」和「下东西」之间犹豫，容易点错。
// 拆开之后 descriptions 各说各的，选择成本就没了。
//
// defineTool 垫片与 dsh-conversation-review 的 lib/tool.js 同款（同一个坑）：
// 宿主 defineTool 只读 `options.output.render`，output 缺失时它不报缺字段，
// 而是在渲染期抛 "output.render failed: userRender is not a function"。
// 这里把顶层 render 归位到 output 下，并顺手拒绝未知参数（宿主生成的参数 schema
// 不带 additionalProperties:false，模型多传字段会静默通过）。
import { defineTool as hostDefineTool } from '@deepseek-ai/dsh-tools';

function textBlock(text) {
  return [{ type: 'text', text }];
}

function defineTool(options) {
  const { render, presentationMeta, ...rest } = options;
  if (rest.output !== undefined) {
    const out = { ...rest.output };
    if (render !== undefined && out.render === undefined) out.render = render;
    if (presentationMeta !== undefined && out.presentationMeta === undefined) out.presentationMeta = presentationMeta;
    rest.output = out;
  }
  if (typeof rest.execute === 'function' && rest.parameters && Object.keys(rest.parameters).length > 0) {
    const allowed = new Set(Object.keys(rest.parameters));
    const userExecute = rest.execute;
    rest.execute = (args, exec) => {
      const unknown = Object.keys(args ?? {}).filter((key) => !allowed.has(key));
      if (unknown.length > 0) {
        throw new Error(`无效参数（未知字段）：${unknown.join('、')}；可用参数：${[...allowed].join('、')}`);
      }
      return userExecute(args, exec);
    };
  }
  return hostDefineTool(rest);
}

function formatBytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n} 毫秒`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)} 秒`;
  const m = Math.floor(n / 60_000);
  const s = Math.round((n % 60_000) / 1000);
  return `${m} 分 ${s} 秒`;
}

const PDF_SCHEMA = {
  type: 'array',
  required: true,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      file: { type: 'string', required: true },
      pages: { type: 'integer', required: true },
      bytes: { type: 'integer', required: true },
      engine: { type: 'string', required: true },
      verified: { type: 'boolean', required: true },
      problems: { type: 'array', required: true, items: { type: 'string' } },
    },
  },
};

/**
 * comic_setup — 环境自检与依赖安装。
 *
 * @param {object} deps { service }
 */
export function defineComicSetupTool({ service }) {
  return defineTool({
    name: 'comic_setup',
    description: '漫画下载插件的环境体检与依赖安装（不涉及下载）。status 检查 Python / jmcomic / Pillow / 下载目录可写性，并把所有候选 Python 的探测记录一起给出（装不上时九成是选错了 Python）；install 用 pip 安装或升级 jmcomic；config 只看当前生效配置。下载漫画用 comic_fetch。',
    parameters: {
      action: { type: 'string', description: 'status=环境自检；install=安装/升级 jmcomic；config=查看生效配置。', enum: ['status', 'install', 'config'], required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          ready: { type: 'boolean', required: true },
          outDir: { type: 'string', required: true },
          outDirWritable: { type: 'boolean', required: true },
          outDirError: { type: 'string', required: true },
          pythonOk: { type: 'boolean', required: true },
          pythonPath: { type: 'string', required: true },
          pythonVersion: { type: 'string', required: true },
          pythonSource: { type: 'string', required: true },
          pythonError: { type: 'string', required: true },
          jmcomicOk: { type: 'boolean', required: true },
          jmcomicVersion: { type: 'string', required: true },
          jmcomicError: { type: 'string', required: true },
          pillowOk: { type: 'boolean', required: true },
          pillowVersion: { type: 'string', required: true },
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                source: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                version: { type: 'string', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
          installOk: { type: 'boolean', required: true },
          installExitCode: { type: 'integer', required: true },
          installTimedOut: { type: 'boolean', required: true },
          installVersion: { type: 'string', required: true },
          installError: { type: 'string', required: true },
          logTail: { type: 'string', required: true },
          configPdf: { type: 'boolean', required: true },
          configKeepImages: { type: 'boolean', required: true },
          configProxy: { type: 'string', required: true },
          configMirror: { type: 'string', required: true },
          configThreads: { type: 'string', required: true },
          configTimeoutMs: { type: 'integer', required: true },
        },
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: 1_000_000,
    async execute(args, exec) {
      if (args.action === 'install') {
        const result = await service.install({ signal: exec?.signal });
        const config = service.status().config;
        return {
          action: 'install',
          ready: result.ok,
          outDir: '',
          outDirWritable: false,
          outDirError: '',
          pythonOk: true,
          pythonPath: result.pythonPath,
          pythonVersion: '',
          pythonSource: '',
          pythonError: '',
          jmcomicOk: result.ok,
          jmcomicVersion: result.version,
          jmcomicError: result.error,
          pillowOk: false,
          pillowVersion: '',
          candidates: [],
          installOk: result.ok,
          installExitCode: Number(result.exitCode) || 0,
          installTimedOut: result.timedOut,
          installVersion: result.version,
          installError: result.error,
          logTail: result.logTail,
          configPdf: config.pdf,
          configKeepImages: config.keepImages,
          configProxy: config.proxy,
          configMirror: config.pythonMirror,
          configThreads: `${config.imageThreads}/${config.photoThreads}`,
          configTimeoutMs: config.timeoutMs,
        };
      }

      const info = service.status();
      return {
        action: args.action,
        ready: info.ready,
        outDir: info.outDir,
        outDirWritable: info.outDirWritable,
        outDirError: info.outDirError,
        pythonOk: info.python.ok,
        pythonPath: info.python.path,
        pythonVersion: info.python.version,
        pythonSource: info.python.source,
        pythonError: info.python.error,
        jmcomicOk: info.jmcomic.ok,
        jmcomicVersion: info.jmcomic.version,
        jmcomicError: info.jmcomic.error,
        pillowOk: info.pillow.ok,
        pillowVersion: info.pillow.version,
        candidates: info.candidates,
        installOk: false,
        installExitCode: 0,
        installTimedOut: false,
        installVersion: '',
        installError: '',
        logTail: '',
        configPdf: info.config.pdf,
        configKeepImages: info.config.keepImages,
        configProxy: info.config.proxy,
        configMirror: info.config.pythonMirror,
        configThreads: `${info.config.imageThreads}/${info.config.photoThreads}`,
        configTimeoutMs: info.config.timeoutMs,
      };
    },
    render(_args, value) {
      if (value.action === 'install') {
        const head = value.installOk
          ? `jmcomic 安装完成：${value.installVersion || '（版本号未知）'}`
          : `jmcomic 安装失败（退出码 ${value.installExitCode}${value.installTimedOut ? '，已超时' : ''}）`;
        const lines = [head, `Python：${value.pythonPath}`];
        if (value.installError) lines.push(`错误：${value.installError}`);
        if (value.logTail) lines.push('', '日志尾部：', value.logTail);
        lines.push('', `装完记得跑一次 comic_setup action=status 复核。`);
        return textBlock(lines.join('\n'));
      }

      const lines = [
        `dsh-comic 环境自检`,
        `下载目录：${value.outDir}（${value.outDirWritable ? '可写 ✓' : `不可写 ✗ ${value.outDirError}`}）`,
      ];
      if (value.pythonOk) {
        lines.push(`Python：${value.pythonVersion}｜${value.pythonPath}（来源 ${value.pythonSource}）`);
      } else {
        lines.push(`Python：✗ ${value.pythonError}`);
      }
      lines.push(value.jmcomicOk
        ? `jmcomic：${value.jmcomicVersion || '已安装'} ✓`
        : `jmcomic：✗ ${value.jmcomicError}`);
      lines.push(value.pillowOk
        ? `Pillow：${value.pillowVersion} ✓（非 JPEG 图片的兜底要用它）`
        : `Pillow：✗ 没有它就只能拼纯 JPEG（jmcomic 默认会转成 JPEG，通常够用）`);
      lines.push('');
      lines.push(value.ready
        ? '结论：可以下载。'
        : value.jmcomicOk === false && value.pythonOk
          ? '结论：还差一步——跑 comic_setup action=install 装 jmcomic。'
          : '结论：还差一步——先解决 Python（见下方候选探测记录）。');

      if (value.candidates.length > 0) {
        lines.push('', '候选 Python 探测记录：');
        for (const item of value.candidates) {
          lines.push(item.ok
            ? `  ✓ ${item.path} → ${item.version}（${item.source}）`
            : `  ✗ ${item.path}（${item.source}）：${item.error || '不可用'}`);
        }
      }

      lines.push('');
      lines.push(`配置：PDF=${value.configPdf ? '开' : '关'}｜保留原图=${value.configKeepImages ? '是' : '否'}｜`
        + `代理=${value.configProxy || '（无）'}｜pip 镜像=${value.configMirror || '（默认源）'}｜`
        + `线程 图/话=${value.configThreads}｜超时=${Math.round(value.configTimeoutMs / 1000)} 秒`);
      return textBlock(lines.join('\n'));
    },
  });
}

/**
 * comic_fetch — 下载漫画、把已有图片转 PDF、列出已下载。
 *
 * @param {object} deps { service }
 */
export function defineComicFetchTool({ service }) {
  return defineTool({
    name: 'comic_fetch',
    description: '下载漫画并转成 PDF（依赖 jmcomic，可先跑 comic_setup 装）。**按名字下载的正确顺序是 search → 用户挑 → download**：action=search 给 query（书名，中日文都行）→ 返回所有同名候选（本子号、全名、作者、标签、页数），一本书名常对应多本（不同卷/不同汉化组/杂志收录单篇），必须让用户挑，别自己猜；action=download 给 album（选定的本子号）→ 下载到临时目录后按 saveMode 出成品（默认 pdf=拼成 A4 PDF、删原图、目录里只留一个 PDF，文件名取作品标题；images=不拼 PDF、图片按作品名进同名文件夹；both=两者都留）；action=convert 给 dir → 把已有图片目录转成 PDF（不用网络、不用 jmcomic，纯 JPEG 零重编码直通）；action=list → 看下载目录里已有的 PDF 与图片文件夹。PDF 写完都会按规范校验（xref/页数/流长度），不过会明说。',
    parameters: {
      action: { type: 'string', description: 'search=按书名搜候选；download=下载并转 PDF；convert=把已有图片目录转 PDF；list=列出已下载的 PDF。', enum: ['search', 'download', 'convert', 'list'], required: true },
      query: { type: 'string', description: 'search 必填：书名/关键词（中文、日文、罗马音都行，也可以用作者名搜）。' },
      album: { type: 'string', description: 'download 必填：本子号（纯数字，来自 search 结果里的 album）。' },
      dir: { type: 'string', description: 'convert 必填：装着图片的目录（绝对路径）。' },
      outDir: { type: 'string', description: 'download/convert 可选：输出目录（省略用配置里的下载目录）。' },
      pdf: { type: 'boolean', description: 'download 可选：是否同时生成 PDF（省略按配置，默认生成）。' },
      saveMode: { type: 'string', description: 'download 可选：成品形态——pdf=拼 PDF 删原图 / images=只要图片（按作品名进同名文件夹）/ both=两者都留。省略按配置（默认 pdf）。', enum: ['pdf', 'images', 'both'] },
      limit: { type: 'integer', description: 'search/list 可选：最多返回几条（search 默认 20、list 默认 50，上限 200）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          album: { type: 'string', required: true },
          root: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          exception: { type: 'string', required: true },
          exitCode: { type: 'integer', required: true },
          durationMs: { type: 'integer', required: true },
          images: { type: 'integer', required: true },
          logTail: { type: 'string', required: true },
          pdfs: PDF_SCHEMA,
          imageDirs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                dir: { type: 'string', required: true },
                name: { type: 'string', required: true },
                images: { type: 'integer', required: true },
                bytes: { type: 'integer', required: true },
              },
            },
          },
          saveMode: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                name: { type: 'string', required: true },
                file: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                images: { type: 'integer', required: true },
              },
            },
          },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                album: { type: 'string', required: true },
                title: { type: 'string', required: true },
                authors: { type: 'array', required: true, items: { type: 'string' } },
                tags: { type: 'array', required: true, items: { type: 'string' } },
                pageCount: { type: 'integer', required: true },
                pubDate: { type: 'string', required: true },
                note: { type: 'string', required: true },
              },
            },
          },
        },
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: 1_800_000,
    async execute(args, exec) {
      if (args.action === 'search') {
        if (typeof args.query !== 'string' || args.query.trim() === '') {
          throw new Error('search 需要 query（书名或关键词）。');
        }
        const result = await service.search({ query: args.query, limit: args.limit, signal: exec?.signal });
        return {
          action: 'search',
          ok: result.ok,
          album: '',
          root: '',
          reason: result.count === 0 ? `没搜到「${result.query}」——换个写法（去掉汉化组名、只留作品名，或改用作者名）。` : '',
          exception: '',
          exitCode: 0,
          durationMs: result.durationMs,
          images: 0,
          logTail: '',
          pdfs: [],
          imageDirs: [],
          saveMode: '',
          count: result.count,
          items: [],
          results: result.items,
        };
      }

      if (args.action === 'download') {
        if (typeof args.album !== 'string' || args.album.trim() === '') {
          throw new Error('download 需要 album（本子号）。');
        }
        const result = await service.download({
          album: args.album,
          outDir: args.outDir,
          pdf: args.pdf,
          saveMode: args.saveMode,
          signal: exec?.signal,
        });
        return {
          action: 'download',
          ok: result.ok,
          album: result.album,
          root: result.root,
          reason: result.reason,
          exception: result.exception,
          exitCode: Number(result.exitCode) || 0,
          durationMs: result.durationMs,
          images: result.images,
          logTail: result.logTail,
          pdfs: result.pdfs,
          imageDirs: result.imageDirs || [],
          saveMode: result.saveMode || '',
          count: 0,
          items: [],
          results: [],
        };
      }

      if (args.action === 'convert') {
        if (typeof args.dir !== 'string' || args.dir.trim() === '') {
          throw new Error('convert 需要 dir（装着图片的目录）。');
        }
        const result = await service.convert({ dir: args.dir, outDir: args.outDir, signal: exec?.signal });
        return {
          action: 'convert',
          ok: result.ok,
          album: '',
          root: result.source,
          reason: '',
          exception: '',
          exitCode: 0,
          durationMs: result.durationMs,
          images: result.images,
          logTail: '',
          pdfs: result.pdfs,
          imageDirs: [],
          saveMode: '',
          count: 0,
          items: [],
          results: [],
        };
      }

      const result = service.list({ limit: args.limit });
      return {
        action: 'list',
        ok: result.exists,
        album: '',
        root: result.outDir,
        reason: result.exists ? '' : '下载目录还不存在（还没有下载过东西）。',
        exception: '',
        exitCode: 0,
        durationMs: 0,
        images: 0,
        logTail: '',
        pdfs: [],
        imageDirs: [],
        saveMode: '',
        count: result.count,
        items: result.items.map((item) => ({
          kind: item.kind || 'pdf',
          name: item.name,
          file: item.file,
          bytes: item.bytes,
          images: Number(item.images) || 0,
        })),
        results: [],
      };
    },
    render(_args, value) {
      if (value.action === 'search') {
        if (value.count === 0) return textBlock(value.reason || '没搜到结果。');
        const lines = [`搜到 ${value.count} 条候选（${formatDuration(value.durationMs)}）：`];
        for (const item of value.results) {
          lines.push('');
          lines.push(`[${item.index}] ${item.album}｜${item.title}`);
          const meta = [];
          if (item.authors.length > 0) meta.push(`作者：${item.authors.join('、')}`);
          if (item.pageCount > 0) meta.push(`${item.pageCount} 页`);
          if (item.pubDate) meta.push(item.pubDate);
          if (meta.length > 0) lines.push(`    ${meta.join('｜')}`);
          if (item.tags.length > 0) lines.push(`    标签：${item.tags.join('、')}`);
          if (item.note) lines.push(`    注意：${item.note}`);
        }
        lines.push('');
        lines.push('同一书名常对应多本（不同卷／不同汉化组／杂志收录的单篇）——把编号和全名给用户挑，别自己拿主意。');
        lines.push('挑定后：comic_fetch action=download album=<本子号>。');
        return textBlock(lines.join('\n'));
      }

      if (value.action === 'list') {
        const head = `下载目录：${value.root}`;
        if (value.count === 0) return textBlock(`${head}\n${value.reason || '（空）'}`);
        const body = value.items.map((item) => (item.kind === 'dir'
          ? `- ${item.name}/｜图片 ${item.images} 张｜${formatBytes(item.bytes)}`
          : `- ${item.name}｜PDF｜${formatBytes(item.bytes)}`)).join('\n');
        return textBlock(`${head}\n共 ${value.count} 项：\n${body}`);
      }

      if (value.action === 'convert') {
        const lines = [
          value.ok ? `转换完成：${value.images} 张图 → ${value.pdfs.length} 本 PDF（${formatDuration(value.durationMs)}）` : `转换完成但有校验问题：${value.pdfs.length} 本 PDF（${formatDuration(value.durationMs)}）`,
          `源目录：${value.root}`,
        ];
        for (const pdf of value.pdfs) {
          lines.push(`- ${pdf.file}｜${pdf.pages} 页｜${formatBytes(pdf.bytes)}｜${pdf.engine}｜${pdf.verified ? '校验通过 ✓' : `校验未过 ✗ ${pdf.problems.join('；')}`}`);
        }
        return textBlock(lines.join('\n'));
      }

      if (!value.ok) {
        const lines = [
          `下载失败：${value.reason}`,
          value.exception ? `异常类型：${value.exception}` : '',
          `目录：${value.root}`,
          `耗时：${formatDuration(value.durationMs)}${value.images > 0 ? `｜已下 ${value.images} 张图` : ''}`,
        ].filter((line) => line !== '');
        if (value.logTail) lines.push('', '日志尾部：', value.logTail);
        return textBlock(lines.join('\n'));
      }

      const lines = [
        `《${value.album}》下载完成：${value.images} 张图（${formatDuration(value.durationMs)}）${value.saveMode ? `｜模式 ${value.saveMode}` : ''}`,
        `目录：${value.root}`,
      ];
      for (const pdf of value.pdfs) {
        lines.push(`- PDF：${pdf.file}｜${pdf.pages} 页｜${formatBytes(pdf.bytes)}｜${pdf.engine}｜${pdf.verified ? '校验通过 ✓' : `校验未过 ✗ ${pdf.problems.join('；')}`}`);
      }
      for (const dir of value.imageDirs) {
        lines.push(`- 图片：${dir.dir}｜${dir.images} 张｜${formatBytes(dir.bytes)}`);
      }
      if (value.pdfs.length === 0 && value.imageDirs.length === 0) {
        lines.push('- （什么都没留下——检查 saveMode 配置）');
      }
      return textBlock(lines.join('\n'));
    },
  });
}
