// lib/pdf.js — 把一本漫画的图片拼成 PDF。
//
// 为什么自己写 PDF 而不是装库：
//   1) jmcomic 下下来的已经是标准 JPEG，PDF 的 DCTDecode 滤镜可以直接把 JPEG 字节
//      塞进去（零重编码、零质量损失），比「先解码再编码」的库更快也更清楚；
//   2) 插件常驻在 DSH 宿主进程里，能少一个依赖就少一个半夜挂掉的理由。
// 只有遇到 JPEG 以外的格式（webp/png，用户改了 jmcomic 的 decode 选项才会出现）
// 才退回用 Pillow —— 它那边什么都认。
//
// 这份实现与「漫画下载」QQ 桥接插件里的 src/comic-pdf.js 同源，改造点只有两处：
// 去掉写死的 python 路径（改由调用方传入），Producer 改成 dsh-comic。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** A4 纵向，单位 pt（PDF 的默认坐标系）。图片等比缩放后居中。 */
const A4 = { width: 595.28, height: 841.89 };

export function isJpeg(buf) {
  return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8;
}

/**
 * 从 JPEG 的 SOF 段读出宽高与颜色分量数。
 *
 * 为什么要自己解析：PDF 的 Image XObject 必须声明 /Width /Height /ColorSpace，
 * 而 jmcomic 存的文件名/后缀不可信（它可能把 webp 存成 .jpg），只有文件头是真的。
 */
export function readJpegInfo(buf) {
  if (!isJpeg(buf)) return null;
  let i = 2;
  while (i < buf.length - 3) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    // 这些段没有长度字段
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS：后面是压缩数据了
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15，排除 DHT(C4)/JPG(C8)/DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      const components = buf[i + 9];
      if (!width || !height) return null;
      return { width, height, components };
    }
    i += 2 + len;
  }
  return null;
}

function colorSpaceOf(components) {
  if (components === 1) return { cs: '/DeviceGray', decode: '' };
  if (components === 4) {
    // CMYK 的 JPEG 在 PDF 里要按 Adobe 惯例反转
    return { cs: '/DeviceCMYK', decode: ' /Decode [1 0 1 0 1 0 1 0]' };
  }
  return { cs: '/DeviceRGB', decode: '' };
}

/** 把一张图按比例放进页面，居中。 */
function fitRect(img, page) {
  const scale = Math.min(page.width / img.width, page.height / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  return { w, h, x: (page.width - w) / 2, y: (page.height - h) / 2 };
}

const fmt = (n) => (Math.round(n * 100) / 100).toString();

/**
 * 纯 JS 拼 PDF（只接受 JPEG）。
 *
 * 结构：catalog → pages → 每页 [page, contents, image]。
 * xref 表里的偏移是**字节**偏移，所以全程用 latin1 累加长度，不能按字符数算。
 */
export function buildPdfFromJpegs({ images, outPath, title }) {
  const chunks = [];
  let pos = 0;
  const offsets = new Map();
  const put = (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1');
    chunks.push(buf);
    pos += buf.length;
  };
  const begin = (id) => { offsets.set(id, pos); };

  const prepared = images.map((file) => {
    const buf = fs.readFileSync(file);
    const info = readJpegInfo(buf);
    if (!info) throw new Error(`不是可用的 JPEG：${path.basename(file)}`);
    return { buf, info };
  });
  const n = prepared.length;
  if (!n) throw new Error('没有可用的图片');

  put('%PDF-1.4\n');
  put(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // 二进制标记，告诉工具别当纯文本处理

  const kids = [];
  for (let i = 0; i < n; i += 1) kids.push(`${5 + i * 3} 0 R`);

  begin(1);
  put('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  begin(2);
  put(`2 0 obj\n<< /Type /Pages /Count ${n} /Kids [${kids.join(' ')}] >>\nendobj\n`);

  for (let i = 0; i < n; i += 1) {
    const { buf, info } = prepared[i];
    const imgId = 3 + i * 3;
    const cntId = 4 + i * 3;
    const pageId = 5 + i * 3;
    const { cs, decode } = colorSpaceOf(info.components);
    const rect = fitRect(info, A4);
    const content = `q\n${fmt(rect.w)} 0 0 ${fmt(rect.h)} ${fmt(rect.x)} ${fmt(rect.y)} cm\n/Im0 Do\nQ\n`;

    begin(imgId);
    put(`${imgId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height}`
      + ` /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode${decode} /Length ${buf.length} >>\nstream\n`);
    put(buf);
    put('\nendstream\nendobj\n');

    begin(cntId);
    put(`${cntId} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);

    begin(pageId);
    put(`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}]`
      + ` /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${cntId} 0 R >>\nendobj\n`);
  }

  // 可选信息（标题）：中文得写成 UTF-16BE 的十六进制串
  const total = 2 + n * 3;
  if (title) {
    const hex = Buffer.from(String(title), 'utf16le').swap16().toString('hex');
    begin(total + 1);
    put(`${total + 1} 0 obj\n<< /Title <FEFF${hex}> /Producer (DSH dsh-comic) >>\nendobj\n`);
  }

  const objCount = title ? total + 1 : total;
  const xrefStart = pos;
  let xref = `xref\n0 ${objCount + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= objCount; id += 1) {
    const off = offsets.get(id) ?? 0;
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  put(xref);
  put(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R${title ? ` /Info ${total + 1} 0 R` : ''} >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  const out = Buffer.concat(chunks);
  fs.writeFileSync(outPath, out);
  return { outPath, pages: n, bytes: out.length, engine: 'jpeg-passthrough' };
}

/** Pillow 兜底：webp/png 这种 DCTDecode 收不了的格式，或者想让 Pillow 重新压一遍。 */
function buildPdfWithPillow({ images, outPath, pythonPath, timeoutMs = 180000 }) {
  if (!pythonPath) throw new Error('需要 Python + Pillow 才能处理非 JPEG 图片（可在配置里指定 pythonPath）');
  const cfgPath = `${outPath}.pillow.json`;
  fs.writeFileSync(cfgPath, JSON.stringify({ images, out: outPath, resolution: 120 }, null, 0), 'utf8');
  const script = [
    'import json, sys',
    'from PIL import Image',
    "cfg = json.load(open(sys.argv[1], 'r', encoding='utf-8'))",
    "pages = [Image.open(p).convert('RGB') for p in cfg['images']]",
    "pages[0].save(cfg['out'], save_all=True, append_images=pages[1:], resolution=float(cfg['resolution']))",
    'print(len(pages))',
  ].join('\n');
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const child = spawn(pythonPath, ['-c', script, cfgPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 只改输出编码，别加 PYTHONUTF8（会把 libcurl 的 CA 路径搞坏）
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已经退了 */ } reject(new Error('PDF 生成超时')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try { fs.rmSync(cfgPath, { force: true }); } catch { /* 临时文件，清不掉也无所谓 */ }
      if (code !== 0) { reject(new Error((err || out || 'Pillow 退出异常').trim().slice(-300))); return; }
      const pages = Number(out.trim().split('\n').pop()) || images.length;
      let bytes = 0;
      try { bytes = fs.statSync(outPath).size; } catch { /* 文件没了后面 verify 会报 */ }
      resolve({ outPath, pages, bytes, engine: 'pillow' });
    });
  });
}

/**
 * 生成 PDF。
 *
 * 全是 JPEG 时走直通（快、无损耗）；有一张不是 JPEG 就整本交给 Pillow，
 * 因为 PDF 页面尺寸要统一，混着两种引擎反而容易错位。
 */
export async function buildComicPdf({ images, outPath, title, pythonPath, timeoutMs }) {
  if (!Array.isArray(images) || !images.length) throw new Error('没有图片可拼');
  let allJpeg = true;
  for (const file of images) {
    let ok = false;
    try { ok = isJpeg(fs.readFileSync(file)); } catch { ok = false; }
    if (!ok) { allJpeg = false; break; }
  }
  if (allJpeg) {
    try {
      return buildPdfFromJpegs({ images, outPath, title });
    } catch {
      // 头解析失败（残缺 JPEG）之类：交给 Pillow 重来一遍，它更宽容
      return buildPdfWithPillow({ images, outPath, pythonPath, timeoutMs });
    }
  }
  return buildPdfWithPillow({ images, outPath, pythonPath, timeoutMs });
}

/**
 * 发出去之前的最后一道检查：这个文件到底是不是一本能打开的 PDF。
 *
 * 为什么要做：写文件这条路一旦「看起来成功了」其实写的是别的东西（半截文件、
 * 还是 jpg、页数不对），打开时就是个坏文件，而日志里全是 ok。
 * 所以这里不看返回值，只重新读盘上的字节，按 PDF 规范把 xref 走一遍。
 *
 * 检查项：%PDF 头 / %%EOF 尾 / startxref 能对上 / xref 每条偏移都指向 `N 0 obj` /
 * /Count 与页对象数量一致 / 每张图的流长度没超出文件。
 */
export function verifyComicPdf({ file, expectPages }) {
  const problems = [];
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    return { ok: false, bytes: 0, pages: 0, problems: [`读不到文件：${error?.message ?? error}`] };
  }
  if (bytes.length < 1024) return { ok: false, bytes: bytes.length, pages: 0, problems: ['文件太小，不像 PDF'] };
  const text = bytes.toString('latin1');
  if (!text.startsWith('%PDF-1.')) problems.push('开头不是 %PDF-1.x');
  const tail = text.slice(-2048);
  if (!/%%EOF\s*$/.test(tail)) problems.push('结尾没有 %%EOF（大概率没写完）');

  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!m) {
    problems.push('找不到 startxref');
  } else {
    const startxref = Number(m[1]);
    const header = /xref\s+0\s+(\d+)\s+/.exec(text.slice(startxref, startxref + 64));
    if (!header) {
      problems.push('startxref 指的位置不是 xref 表');
    } else {
      const count = Number(header[1]);
      const entriesStart = startxref + header[0].length;
      for (let id = 1; id < count; id += 1) {
        const entry = text.slice(entriesStart + id * 20, entriesStart + id * 20 + 20);
        if (entry.length !== 20 || !/^\d{10} \d{5} n /.test(entry)) { problems.push(`xref 第 ${id} 条坏了`); break; }
        const off = Number(entry.slice(0, 10));
        if (!text.startsWith(`${id} 0 obj`, off)) { problems.push(`对象 ${id} 的偏移对不上`); break; }
      }
    }
  }

  const pages = Number(/\/Type \/Pages \/Count (\d+)/.exec(text)?.[1] ?? 0);
  if (!pages) problems.push('没有页数（/Count 缺失）');
  if (expectPages && pages && pages !== expectPages) problems.push(`页数 ${pages} ≠ 图片 ${expectPages} 张`);

  // 每个图片流声明的长度不能越出文件
  const re = /\/Subtype \/Image[\s\S]*?\/Length (\d+) >>\nstream\n/g;
  let hit;
  let imageCount = 0;
  while ((hit = re.exec(text)) !== null) {
    imageCount += 1;
    const declared = Number(hit[1]);
    const start = hit.index + hit[0].length;
    if (start + declared > bytes.length) { problems.push(`第 ${imageCount} 张图的流被截断`); break; }
    if (!text.startsWith('\nendstream', start + declared)) { problems.push(`第 ${imageCount} 张图后面不是 endstream`); break; }
  }
  if (pages && imageCount !== pages) problems.push(`图对象 ${imageCount} 个 ≠ 页数 ${pages}`);

  return { ok: problems.length === 0, bytes: bytes.length, pages, problems };
}
