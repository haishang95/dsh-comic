// test/pdf.test.mjs — PDF 拼装与校验。
//
// 这里用一张 1×1 的真 JPEG（内嵌 base64，不依赖任何外部文件/网络）反复拼，
// 逐项验：能拼出来、xref 对得上、页数对得上、截断后能被验出来。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildComicPdf,
  buildPdfFromJpegs,
  isJpeg,
  readJpegInfo,
  verifyComicPdf,
} from '../lib/pdf.js';

/** 1×1 灰度 JPEG。SOF0 里 height=1 / width=1 / components=1。 */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-comic-test-'));
}

/** 造 n 张一样的 JPEG，返回文件路径数组。 */
function makeImages(dir, n) {
  const files = [];
  for (let i = 1; i <= n; i += 1) {
    const file = path.join(dir, `${String(i).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, TINY_JPEG);
    files.push(file);
  }
  return files;
}

test('isJpeg / readJpegInfo 认得这张 1×1 JPEG', () => {
  assert.equal(isJpeg(TINY_JPEG), true);
  assert.equal(isJpeg(Buffer.from('not an image')), false);
  const info = readJpegInfo(TINY_JPEG);
  assert.ok(info, '应该解析出 SOF 段');
  assert.equal(info.width, 1);
  assert.equal(info.height, 1);
  assert.equal(info.components, 1);
});

test('readJpegInfo 对非 JPEG 返回 null', () => {
  assert.equal(readJpegInfo(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), null);
  assert.equal(readJpegInfo(Buffer.alloc(0)), null);
});

test('拼出来的 PDF 能被 verifyComicPdf 验过，页数与图片数一致', () => {
  const dir = tempDir();
  try {
    const images = makeImages(dir, 3);
    const outPath = path.join(dir, 'book.pdf');
    const built = buildPdfFromJpegs({ images, outPath, title: '测试本子' });
    assert.equal(built.pages, 3);
    assert.equal(built.engine, 'jpeg-passthrough');
    assert.ok(built.bytes > 1024, `PDF 应该大于 1KB，实际 ${built.bytes}`);

    const verified = verifyComicPdf({ file: outPath, expectPages: 3 });
    assert.deepEqual(verified.problems, [], `不该有问题：${verified.problems.join('；')}`);
    assert.equal(verified.ok, true);
    assert.equal(verified.pages, 3);

    // 中文标题要能落进 /Info（UTF-16BE 十六进制串）
    const text = fs.readFileSync(outPath).toString('latin1');
    assert.match(text, /\/Producer \(DSH dsh-comic\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyComicPdf 能抓出被截断的 PDF', () => {
  const dir = tempDir();
  try {
    const images = makeImages(dir, 2);
    const outPath = path.join(dir, 'cut.pdf');
    buildPdfFromJpegs({ images, outPath });
    const full = fs.readFileSync(outPath);
    fs.writeFileSync(outPath, full.subarray(0, Math.floor(full.length * 0.6)));
    const verified = verifyComicPdf({ file: outPath });
    assert.equal(verified.ok, false);
    assert.ok(verified.problems.length > 0, '截断后必须报出问题');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyComicPdf 对不存在的文件不抛异常，只报问题', () => {
  const verified = verifyComicPdf({ file: path.join(tempDir(), 'nope.pdf') });
  assert.equal(verified.ok, false);
  assert.equal(verified.pages, 0);
});

test('buildComicPdf 全 JPEG 时走直通引擎', async () => {
  const dir = tempDir();
  try {
    const images = makeImages(dir, 2);
    const outPath = path.join(dir, 'auto.pdf');
    const built = await buildComicPdf({ images, outPath, pythonPath: '' });
    assert.equal(built.engine, 'jpeg-passthrough');
    assert.equal(built.pages, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildComicPdf 没图时报错', async () => {
  await assert.rejects(() => buildComicPdf({ images: [], outPath: 'x.pdf' }), /没有图片/);
});
