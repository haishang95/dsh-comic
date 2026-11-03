// lib/index.js — dsh-comic 宿主半（cordis 插件）。
//
// 这个插件只做一件事：**把「下漫画」和「转 PDF」这两步接进 DSH，跑在一趟里。**
//
//   ① 下载：调 jmcomic（Python 第三方包，本插件不打包它的源码，只负责调用）；
//   ② 转 PDF：纯 JS 拼装，JPEG 直接走 DCTDecode 零重编码，非 JPEG 才退回 Pillow；
//   ③ 校验：写完重新读盘、按 PDF 规范把 xref 走一遍——不看返回值，看字节。
//
// 分工说明（免得被当成全能下载器）：
//   - 下载按「本子号」走；按书名找号用 action=search（结果会列全名与标签供挑选）；
//   - 需要登录或会员的内容，jmcomic 匿名下不了，本插件如实报 NeedLogin；
//   - 下载内容版权归原作者，插件不做任何转发或再分发。
//
// 落盘约定：成品目录是平的，形态由 saveMode 决定——`pdf` 只留 `<outDir>/<作品名>.pdf`；
// `images` 只留 `<outDir>/<作品名>/`；`both` 两个并排。中转目录一律删。
// 想留原图的把 keepImages 打开，它们会挪进 `<outDir>/.images/`（隐藏目录，不碍眼）。
import z from '@deepseek-ai/schemastery';
import { createComicService } from './service.js';
import { defineComicFetchTool, defineComicSetupTool } from './tool.js';
import { createSettingsStore } from './settings.js';
import { registerComicRoutes } from './routes.js';

/** Cordis 插件名——必须与 cordis.patch.yml 的行 id 一致。 */
export const name = 'dsh-comic';

/** tools 是工具面的底座；webServer 用来挂界面要调的那几条 HTTP 路由。 */
export const inject = ['tools', 'webServer'];

/**
 * 可调项。
 *
 * 默认值的重要性：plugins 装进 profile 后，cordis.patch.yml 里的 config 是唯一入口，
 * 所以这里的 default 必须与 patch 里的值一致，否则「改 patch 没反应」会被当成 bug。
 */
export const Config = z.object({
  /** 指定 Python 全路径；空 = 自动探测（DSH 自带 → 常见安装位置 → PATH）。 */
  pythonPath: z.string().default(''),
  /** 下载目录；空 = 用户 Downloads 下的「漫画」。 */
  outDir: z.string().default(''),
  /** 下载完是否顺手转 PDF。 */
  pdf: z.boolean().default(true),
  /** 成品形态：pdf=拼 PDF 删原图 / images=只要图片 / both=两者都留。界面里的设置优先于这里。 */
  saveMode: z.string().default('pdf'),
  /** 转完 PDF 后是否保留原始图片（0.2.x 的老开关，现在映射成 saveMode='both'）。 */
  keepImages: z.boolean().default(false),
  /** 下载代理，例如 http://127.0.0.1:7890；空 = 直连。 */
  proxy: z.string().default(''),
  /** pip 镜像源（装 jmcomic 用）；空 = pip 默认源。 */
  pythonMirror: z.string().default('https://pypi.tuna.tsinghua.edu.cn/simple'),
  /** jmcomic 的图片并发线程数。 */
  imageThreads: z.number().default(8),
  /** jmcomic 的话（章节）并发线程数。 */
  photoThreads: z.number().default(4),
  /** 单次下载超时（毫秒）。 */
  timeoutMs: z.number().default(600_000),
  /** 安装 jmcomic 的超时（毫秒）——第一次装要把 Pillow / curl_cffi 一起拉下来。 */
  installTimeoutMs: z.number().default(900_000),
});

const DEFAULTS = {
  pythonPath: '',
  outDir: '',
  pdf: true,
  saveMode: 'pdf',
  keepImages: false,
  proxy: '',
  pythonMirror: 'https://pypi.tuna.tsinghua.edu.cn/simple',
  imageThreads: 8,
  photoThreads: 4,
  timeoutMs: 600_000,
  installTimeoutMs: 900_000,
};

export function apply(ctx, rawConfig) {
  // 配置以 patch 里的值为准，缺的字段用 DEFAULTS 兜底——Config 的 default 只在
  // 经由 schema 解析时生效，直接读 rawConfig 的路径（例如单测）拿不到它。
  const resolved = { ...DEFAULTS, ...(rawConfig ?? {}) };

  // 界面改的设置（入口形态 / 下载目录 / 是否直接下）是运行时读写的，
  // 落一小份 JSON；每次 getConfig 现读，所以界面上一改，下一次下载立刻生效，不用重启。
  const settings = createSettingsStore();

  const getConfig = () => {
    const now = settings.read();
    return {
      ...resolved,
      // 界面里填的下载目录优先于 patch 里的 outDir
      outDir: now.downloadDir || resolved.outDir,
      // 成品形态同理：界面选什么就是什么（设置文件里永远有完整默认值，所以它总是赢）
      saveMode: now.saveMode || resolved.saveMode,
    };
  };

  const service = createComicService({ getConfig, logger: ctx.logger });

  // 注册放在 ctx.effect 里，卸载插件时两个工具一起摘掉——不指望 tools 服务
  // 替我们管生命周期，conversation-review 那种裸 register 在热重载时会留下幽灵工具。
  ctx.effect(() => {
    const offSetup = ctx.tools.register(defineComicSetupTool({ service }));
    const offFetch = ctx.tools.register(defineComicFetchTool({ service }));
    return () => {
      offSetup?.();
      offFetch?.();
    };
  }, 'dsh-comic/tools');

  // 界面要调的那几条路由（搜索/下载/设置/封面代理）。摘除交给 ctx.effect，
  // 否则热重载会撞 duplicate route。
  ctx.effect(() => {
    if (!ctx.webServer) {
      ctx.logger?.warn?.('[dsh-comic] 没有 webServer 服务，界面接口未挂载（工具仍然可用）');
      return () => {};
    }
    return registerComicRoutes({ webServer: ctx.webServer, service, settings, logger: ctx.logger });
  }, 'dsh-comic/routes');

  ctx.logger?.info?.(
    `[dsh-comic] 漫画下载已挂载：下载目录 ${service.outDirOf(resolved)}｜`
    + `Python ${resolved.pythonPath || '自动探测'}｜PDF=${resolved.pdf ? '开' : '关'}`
    + `（首次使用先跑 comic_setup action=status 体检）`,
  );

  // 给测试/诊断用：插件私有 service。
  return service;
}
