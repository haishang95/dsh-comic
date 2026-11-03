// test/comic.test.mjs — option.yml 渲染、排序、目录分组、失败翻译、本子号校验。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectImageDirs,
  detectFatal,
  explainFailure,
  isPythonLauncher,
  naturalCompare,
  pdfNameForGroup,
  renderOptionYaml,
} from '../lib/jmcomic.js';
import { createComicService, normalizeAlbum, resolveSaveMode, saveImageDirs } from '../lib/service.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-comic-test-'));
}

test('isPythonLauncher 认得 python 家族，不认别的东西', () => {
  assert.equal(isPythonLauncher('python'), true);
  assert.equal(isPythonLauncher('python3'), true);
  assert.equal(isPythonLauncher('py'), true);
  assert.equal(isPythonLauncher('C:\\Python312\\python.exe'), true);
  assert.equal(isPythonLauncher('/usr/bin/python3'), true);
  assert.equal(isPythonLauncher('C:\\x\\pythonw.exe'), true);
  assert.equal(isPythonLauncher('jmcomic.exe'), false);
  assert.equal(isPythonLauncher('node.exe'), false);
  assert.equal(isPythonLauncher(''), false);
});

test('renderOptionYaml：base_dir 转正斜杠、单引号包住', () => {
  const yaml = renderOptionYaml({ baseDir: 'C:\\Users\\a\\Downloads\\漫画\\123' });
  assert.match(yaml, /base_dir: 'C:\/Users\/a\/Downloads\/漫画\/123'/);
  assert.match(yaml, /rule: 'Bd_Aauthor_Atitle_Pindex'/);
  assert.match(yaml, /decode: true/);
  assert.match(yaml, /proxies: \{\}/);
  // 没有代理时不该出现 http/https 子键
  assert.doesNotMatch(yaml, /http:/);
});

test('renderOptionYaml：有代理时写进 proxies', () => {
  const yaml = renderOptionYaml({ baseDir: '/tmp/x', proxy: 'http://127.0.0.1:7890', imageThreads: 4, photoThreads: 2 });
  assert.match(yaml, /proxies:\n {8}http: 'http:\/\/127\.0\.0\.1:7890'\n {8}https: 'http:\/\/127\.0\.0\.1:7890'/);
  assert.match(yaml, /image: 4/);
  assert.match(yaml, /photo: 2/);
});

test('renderOptionYaml：threading 必须嵌在 download 下（缩进 4 空格）', () => {
  // 写成顶层键会被 JmOption(**dic) 当成构造参数，报
  // `TypeError: JmOption.__init__() got an unexpected keyword argument 'threading'`
  // ——version 达到 JM_OPTION_VER 时不会走旧版兼容搬家，所以结构必须一次写对。
  const yaml = renderOptionYaml({ baseDir: '/tmp/x', imageThreads: 6, photoThreads: 3 });
  assert.match(yaml, /\n {2}threading:\n {4}image: 6\n {4}photo: 3/);
  assert.doesNotMatch(yaml, /\nthreading:/);
});

test('renderOptionYaml：单引号会被转义成两个', () => {
  const yaml = renderOptionYaml({ baseDir: "/tmp/it's" });
  assert.match(yaml, /base_dir: '\/tmp\/it''s'/);
});

test('naturalCompare 让 2 排在 10 前面', () => {
  const sorted = ['10.jpg', '2.jpg', '1.jpg', '21.jpg'].sort(naturalCompare);
  assert.deepEqual(sorted, ['1.jpg', '2.jpg', '10.jpg', '21.jpg']);
});

test('collectImageDirs 按「装着图的目录」分组，各组内部自然排序', () => {
  const dir = tempDir();
  try {
    // 结构：<root>/作者/标题/第1话/001..003.jpg、<root>/作者/标题/第2话/001..002.jpg
    const ch1 = path.join(dir, '作者', '标题', '第1话');
    const ch2 = path.join(dir, '作者', '标题', '第2话');
    fs.mkdirSync(ch1, { recursive: true });
    fs.mkdirSync(ch2, { recursive: true });
    for (const n of ['10', '2', '1']) fs.writeFileSync(path.join(ch1, `${n}.jpg`), 'x');
    for (const n of ['1', '2']) fs.writeFileSync(path.join(ch2, `${n}.jpg`), 'x');
    fs.writeFileSync(path.join(dir, '作者', '标题', 'notes.txt'), 'x');

    const groups = collectImageDirs(dir);
    assert.equal(groups.length, 2);
    const first = groups.find((g) => g.dir.endsWith('第1话'));
    assert.ok(first);
    assert.equal(first.images.length, 3);
    assert.deepEqual(first.images.map((f) => path.basename(f)), ['1.jpg', '2.jpg', '10.jpg']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectImageDirs 对空目录返回空数组（不抛）', () => {
  const dir = tempDir();
  try {
    assert.deepEqual(collectImageDirs(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectFatal 从日志里认出 jmcomic 的异常名', () => {
  const log = '...\nTraceback (most recent call last):\njmcomic.jm_exception.NeedLogin: 需要登录\n';
  assert.equal(detectFatal(log), 'NeedLogin');
  assert.equal(detectFatal('一切正常'), '');
});

test('explainFailure 把异常名翻译成人话', () => {
  assert.match(explainFailure('NeedLogin', ''), /登录/);
  assert.match(explainFailure('MissingAlbumPhoto', ''), /本子号不存在/);
  assert.match(explainFailure('ApiFailed', ''), /网络|代理/);
  // 认不出的异常名：至少要把日志尾巴带出来
  const text = explainFailure('WeirdError', 'line1\nline2\nline3');
  assert.match(text, /WeirdError/);
  assert.match(text, /line3/);
  // 没有异常名时，只有尾巴
  assert.equal(explainFailure('', 'boom'), 'boom');
});

test('normalizeAlbum 只放行像号的输入', () => {
  assert.equal(normalizeAlbum(' 350234 '), '350234');
  assert.equal(normalizeAlbum('123,456'), '123,456');
  assert.throws(() => normalizeAlbum(''), /本子号/);
  assert.throws(() => normalizeAlbum('rm -rf /'), /本子号/);
  assert.throws(() => normalizeAlbum('abc def'), /本子号/);
});

test('pdfNameForGroup 取作品标题，不取章节号', () => {
  const root = path.join('C:', 'Users', 'x', 'Downloads', '漫画', '498992');
  const dir = path.join(root, '多作者', '[透明聲彩漢化組] サキュバス百合えっち Vol.1', '1');
  assert.equal(pdfNameForGroup(dir, root), '[透明聲彩漢化組] サキュバス百合えっち Vol.1');

  // 同一本的第二话：章节号不同、标题相同 —— 名字也该相同（去重交给调用方）
  const dir2 = path.join(root, '多作者', '[透明聲彩漢化組] サキュバス百合えっち Vol.1', '2');
  assert.equal(pdfNameForGroup(dir2, root), '[透明聲彩漢化組] サキュバス百合えっち Vol.1');
});

test('pdfNameForGroup 的兜底：根目录自己 / 全数字路径', () => {
  const root = path.join('D:', '漫画', '某本书');
  assert.equal(pdfNameForGroup(root, root), '某本书');

  const numeric = path.join(root, '1', '2');
  assert.equal(pdfNameForGroup(numeric, root), '1_2');
});

/** 造一个只认 outDir 的 service（list/search 不碰网络，够用）。 */
function serviceIn(outDir) {
  return createComicService({
    getConfig: () => ({ outDir, keepImages: false, pdf: true }),
    logger: { info() {}, warn() {} },
  });
}

test('list 扫平铺 PDF，跳过临时目录与原图目录', () => {
  const outDir = tempDir();
  try {
    fs.writeFileSync(path.join(outDir, '作品甲.pdf'), 'x');
    fs.writeFileSync(path.join(outDir, '作品乙.pdf'), 'yy');
    fs.writeFileSync(path.join(outDir, '不是PDF.txt'), 'x');
    // 临时下载树：里面的图与中间 PDF 都不该出现在成品列表里
    const tmp = path.join(outDir, '.dsh-comic-tmp', '498992', '作者');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, '半成品.pdf'), 'x');
    fs.writeFileSync(path.join(tmp, '1.jpg'), 'x');
    // 老结构（扁平化之前的 <本子号>/…/*.pdf）仍然列出来，别让老文件消失
    const legacy = path.join(outDir, '350234', '作者', '标题');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, '旧书.pdf'), 'x');

    const result = serviceIn(outDir).list();
    assert.equal(result.exists, true);
    const names = result.items.map((item) => item.name).sort();
    assert.deepEqual(names, ['作品乙.pdf', '作品甲.pdf', '旧书.pdf'].sort());
    assert.equal(result.count, 3);
    assert.ok(result.items.every((item) => item.file.endsWith('.pdf')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('list 对不存在的目录返回 exists:false，不抛', () => {
  const result = serviceIn(path.join(tempDir(), '根本没这个目录')).list();
  assert.equal(result.exists, false);
  assert.equal(result.count, 0);
});

test('search 没给 query 直接报错（不用联网、不用 Python）', async () => {
  await assert.rejects(() => serviceIn(tempDir()).search({ query: '   ' }), /query/);
});

test('resolveSaveMode：三模式直给，老 keepImages=true 映射成 both', () => {
  assert.equal(resolveSaveMode({ saveMode: 'pdf' }), 'pdf');
  assert.equal(resolveSaveMode({ saveMode: 'images' }), 'images');
  assert.equal(resolveSaveMode({ saveMode: 'both' }), 'both');
  // 老配置：keepImages 是「PDF 和原图都留」的意思
  assert.equal(resolveSaveMode({ keepImages: true }), 'both');
  // 老配置：只关 PDF = 只要图
  assert.equal(resolveSaveMode({ pdf: false }), 'images');
  assert.equal(resolveSaveMode({}), 'pdf');
  assert.equal(resolveSaveMode({ saveMode: '胡写的' }), 'pdf');
});

test('list 把「直接装着图片的目录」认成图片成品，封面取自然排序第一张', () => {  const outDir = tempDir();
  try {
    const dir = path.join(outDir, '作品丙');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '00002.jpg'), 'xx');
    fs.writeFileSync(path.join(dir, '00001.jpg'), 'x');
    fs.writeFileSync(path.join(dir, '说明.txt'), 'x');
    fs.writeFileSync(path.join(outDir, '作品甲.pdf'), 'x');

    const result = serviceIn(outDir).list();
    const dirItem = result.items.find((item) => item.kind === 'dir');
    assert.ok(dirItem, '应该有一个图片文件夹条目');
    assert.equal(dirItem.name, '作品丙');
    assert.equal(dirItem.images, 2);
    assert.ok(dirItem.cover.endsWith('00001.jpg'), `封面应是 00001.jpg，实际 ${dirItem.cover}`);
    assert.equal(result.items.filter((item) => item.kind === 'pdf').length, 1);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});


test('saveImageDirs：按作品标题建文件夹，图片扁平放进去，不带章节名', () => {
  const base = tempDir();
  try {
    const root = path.join(base, 'in');
    const group = path.join(root, '多作者', '作品丁', '1');
    fs.mkdirSync(group, { recursive: true });
    fs.writeFileSync(path.join(group, '00001.jpg'), 'aa');
    fs.writeFileSync(path.join(group, '00002.jpg'), 'bbb');

    const outBase = path.join(base, 'out');
    fs.mkdirSync(outBase, { recursive: true });

    const saved = saveImageDirs({ groups: collectImageDirs(root), outBase, root });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, '作品丁');
    assert.equal(saved[0].images, 2);
    assert.equal(saved[0].bytes, 5);
    assert.ok(fs.existsSync(path.join(outBase, '作品丁', '00001.jpg')));
    assert.ok(fs.existsSync(path.join(outBase, '作品丁', '00002.jpg')));
    assert.ok(!fs.existsSync(path.join(outBase, '作品丁', '1')), '不该把章节号那层带进成品');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('saveImageDirs：两本书同名时依次加 (2)，不互相覆盖', () => {
  const base = tempDir();
  try {
    const root = path.join(base, 'in');
    for (const author of ['作者甲', '作者乙']) {
      const dir = path.join(root, author, '同名作品', '1');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '00001.jpg'), author === '作者甲' ? 'a' : 'bb');
    }
    const outBase = path.join(base, 'out');
    fs.mkdirSync(outBase, { recursive: true });

    const saved = saveImageDirs({ groups: collectImageDirs(root), outBase, root });
    const names = saved.map((item) => item.name);
    assert.equal(names.length, 2);
    assert.ok(names.includes('同名作品'));
    assert.ok(names.some((name) => name === '同名作品 (2)'), `实际：${names.join(' / ')}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
