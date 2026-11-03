# dsh-comic

给 DSH 装一个「下漫画 → 转 PDF」的工具。针对 jmcomic 做了封装：环境自检、装依赖、下载、拼 PDF、校验，一趟跑完。

## 它做什么

- **搜**：按书名/作者搜候选，列出**全名、作者、标签、页数**——一本书名常对应多本（不同卷、不同汉化组、杂志收录的单篇），所以这一步是给人挑的，不是给模型猜的。
- **下载**：按本子号（如 `350234`）调 [jmcomic](https://github.com/hect0x7/JMComic-Crawler-Python) 下载。
  - 下载先落在 `<下载目录>/.dsh-comic-tmp/<本子号>/` 这个**中转目录**里（jmcomic 的 `作者/标题/章节/页码.jpg` 结构照旧）；
  - 出什么成品由 **`saveMode`** 决定（界面「设置 → 下载成品」里选，三种）：
    - `pdf`（默认）——拼成一本 PDF，**中转目录整棵删掉**，成品目录只剩 `作品名.pdf`；
    - `images`——不拼 PDF，图片按作品名复制进 `<下载目录>/作品名/`（扁平，不带 `作者/章节` 那几层）；
    - `both`——两个都留，`作品名.pdf` 与 `作品名/` 并排，一眼能认出一对；
  - 老配置里的 `keepImages: true` 等于 `both`（0.2.x 是把原图挪进 `.images/`，现在统一成同名文件夹）。
- **转 PDF**：每一话拼成一本 A4 纵向 PDF，图片等比缩放居中。
  - **PDF 名取作品标题，不取章节号**：jmcomic 的目录是 `作者/标题/章节号/页码.jpg`，图片实际躺在那层「章节号」目录里（`1`、`2`…），直接拿目录名当文件名会让每本书都叫 `1.pdf`。起名时沿路径往回找**最后一个非纯数字片段**，那才是标题；同一本书里重名时依次加 ` (2)` ` (3)`；路径全是数字（自己按序号分类的目录）就退回数字拼接。
  - 全是 JPEG 时走 **DCTDecode 直通**——把 JPEG 字节原样塞进 PDF，零重编码、零质量损失；
  - 有非 JPEG（png/webp）时整本交给 Pillow 重来，因为 PDF 页面尺寸要统一。
- **校验**：写完重新读盘，按 PDF 规范把 xref 走一遍（头/尾/startxref/每条偏移/页数/流长度）。校验不过会明说，不会假装成功。
- **环境体检**：把所有候选 Python 都探一遍并列出结果——装不上时九成是选错了 Python。

它**不**提供排行榜与推荐；也**不**转发、不打包别人的作品。

## 界面

插件带一个浏览器里的操作面板（不用命令行，也不用找模型）：

- **输入 JM 号或漫画名** → 直接给号就开下；按名字搜到**一个**结果也直接开下；搜到**多个**就列成卡片——封面、全名、作者、标签、页数、日期，挑哪本下哪本。一本书名对应多本（不同卷 / 不同汉化组 / 杂志单篇）是常态，所以这里必须由人点。
- **下完就能看**：完成页列出成品条目，点**「查看」**在面板里打开——PDF 用内嵌阅读器（支持分段取页），图片文件夹用大图 + 缩略图网格翻看；点**「用系统打开」**交给本地程序（阅读器 / 资源管理器）。
  - 顺带说明：**没做进右侧栏**。右栏的 tab 由宿主自己的 right Sidebar controller 选（kind 只有 document / files / guide），第三方插件塞不进自己的文档 tab，`layout.openRightbar()` 只负责开栏、内容不归我们管——硬开会得到一条空栏。所以查看做在面板里，从侧栏/悬浮入口点开，一样是在 dsh 里看。
- **下载成品三选一**：`pdf`（默认，拼 PDF 删原图）/ `images`（只要图片，按作品名进同名文件夹）/ `both`（PDF 与同名文件夹并排）。
- **下载文件夹**：在面板里的「设置」里填，旁边可点「选择文件夹」；**「直接下载至设置文件夹」**勾上就直接下，不勾则每次下载前弹目录选择框。
- **入口两选一**（默认「悬浮图标」）：
  - `悬浮图标` —— 右下角一个 JM 圆按钮，点开就是搜索框（默认）；
  - `添加至侧栏` —— 左侧栏底部多一个「漫画」按钮。
- **设置在哪进**：点开悬浮图标 / 侧栏按钮后，面板右上角的**「设置」**。不依赖 `设置 → 插件` 那几个槽位——desktop profile 里 `ui-settings` 相关几行是 `enabled: false`，往那儿注册的 tab 根本不显示（2026-11-02 踩过，已改）。
- 改完立刻生效，**不用重启**（设置落在 `<DSH_HOME>/data/dsh-comic/settings.json`）。
- 界面上不提供「关闭」选项——关掉就再没有入口能改回来；真要关就手改 `settings.json` 里的 `entryMode`（`off` 仍然合法）。

界面数据走宿主自带的 HTTP 服务：`/api/dsh-comic/{settings,search,download,job,list,status,ping,cover,file,dir,open}`，只接受本机请求。`file`/`dir`/`open` 只能碰**成品目录内**的路径（先 resolve 再 realpath 解软链，两步都在根里才放行），`file` 支持 Range 供 PDF 阅读器分段取页。封面由宿主代理转发（浏览器直连图床会撞 referer/CORS），且只放行图床域名的 URL——这个代理不是通用代理，别拿它当跳板。

## 工具

### `comic_setup`

| action | 作用 |
|---|---|
| `status` | 体检：Python / jmcomic / Pillow / 下载目录可写性 + 全部候选 Python 的探测记录 |
| `install` | `pip install -U jmcomic`（用配置的镜像源） |
| `config` | 只看当前生效配置 |

### `comic_fetch`

| action | 参数 | 作用 |
|---|---|---|
| `search` | `query`（必填）、`limit` | 按书名搜候选，返回本子号 + 全名 + 作者 + 标签 + 页数 |
| `download` | `album`（必填）、`outDir`、`pdf`、`saveMode` | 下载并按 `saveMode` 出成品（默认 pdf） |
| `convert` | `dir`（必填）、`outDir` | 把已有图片目录转 PDF（不需要网络、不需要 jmcomic） |
| `list` | `limit` | 列出下载目录里的 PDF 与图片文件夹 |

**推荐顺序**：`search` → 用户从候选里挑 → `download album=<号>`。一本书名对应多本时，别替用户拿主意。

## 依赖

**Python 3.9+ + jmcomic**（下载需要）。

- jmcomic 2.7.10 的 PyPI classifiers 里明确列了 **Python 3.14**，官方文档也推荐 3.14，不必刻意退回旧版本。
- 硬依赖是 `commonx / curl-cffi / pillow / pycryptodome / pyyaml`，都有现成轮子；`curl-cffi` 走 `abi3` 轮子，对 3.14 同样有效。
- 插件不打包 jmcomic 的源码，只负责调用。
- 纯 `convert`（只转 PDF）不需要 jmcomic；全 JPEG 时连 Pillow 都不需要。

**为什么不用 jmcomic 自带的 PDF 插件**：那套要 `pip install "jmcomic[plugins]"` 额外拉 `img2pdf` / `pikepdf`，而且只按整本目录合并。本插件的 `lib/pdf.js` 零依赖、JPEG 直通、写完还能独立校验，也能脱离下载单独当转换器用（`comic_fetch convert`）。

## 安装

在工作区外的持久位置放好这个目录，然后用：

```
plugin_manager action=install_bundle target=<本目录绝对路径>
```

装完跑一次 `comic_setup action=status` 复核。

## 配置（cordis.patch.yml 或面板）

| 键 | 默认 | 说明 |
|---|---|---|
| `pythonPath` | `''` | Python 全路径；空 = 自动探测（常见安装位置 → PATH → DSH 自带运行时兜底），并且在能跑的里面优先挑**已经装了 jmcomic** 的那个 |
| `outDir` | `''` | 下载目录；空 = `~/Downloads/漫画` |
| `pdf` | `true` | 下载完是否顺手转 PDF（`saveMode` 缺省时才看它） |
| `saveMode` | `pdf` | 成品形态：`pdf` / `images` / `both`。界面的设置优先于这里 |
| `keepImages` | `false` | 0.2.x 的老开关，只在 `saveMode` 缺省时生效（`true` → `both`） |
| `proxy` | `''` | 下载代理，如 `http://127.0.0.1:7890` |
| `pythonMirror` | 清华源 | pip 镜像；空 = 默认源 |
| `imageThreads` | `8` | jmcomic 图片并发 |
| `photoThreads` | `4` | jmcomic 章节并发 |
| `timeoutMs` | `600000` | 单次下载超时 |
| `installTimeoutMs` | `900000` | 安装超时 |

## 几个踩过的坑（都写进代码了）

1. **jmcomic 失败时退出码是 0。** 只能从日志里认 `jmcomic.jm_exception.XXX`。本插件扫这个异常名，认不出才算"原因不明"。
2. **`python -m jmcomic` 跑不了。** jmcomic 没有 `__main__.py`，会报 `No module named jmcomic.__main__`；正确入口是 `from jmcomic.cli import main; main()`。
3. **不能设 `PYTHONUTF8=1`。** 会让 libcurl 读不到 cacert.pem，所有请求变成 `curl: (77) error adding trust anchors`。只设 `PYTHONIOENCODING=utf-8`。
4. **Windows 上 PATH 里的 `python` 常常是假的**（WindowsApps 的空壳别名，点开跳商店）。所以探测顺序里它排在具体安装目录之后。
5. **别让 DSH 自带的 Python 抢在最前面。** 它是宿主的私有运行时，往里 pip 装包既不干净也活不过升级；更要命的是它可能没装 jmcomic，而用户自己的 Python 装了——插件就会挑错人。所以它只作最后兜底，且探测时会优先选已经装了 jmcomic 的那个。
6. **PDF 的 xref 是字节偏移。** 全程用 `latin1` 累加长度，按字符数算会错位。
7. **JSON 配置文件别存成 UTF-8 with BOM。** `JSON.parse` 会在 `\ufeff` 上报 `Unexpected token`。
8. **`threading` 必须嵌在 `download` 底下。** 写成顶层键会被 `JmOption(**dic)` 当成构造参数，报 `TypeError: JmOption.__init__() got an unexpected keyword argument 'threading'`；而 option.yml 里 `version: '2.1'` 正好等于 `JM_OPTION_VER`，会跳过旧版兼容搬家，没有第二次机会。
9. **PDF 名别取图片所在的那层目录。** 那层往往只是章节号（`1`、`2`…），取它会让每本书都叫 `1.pdf`——名字要沿路径往回找到作品标题（见上文「转 PDF」）。
10. **jmcomic 的 CLI 没有搜索。** 它的 `id_list` 只认本子号（或 `p333` 形式的 photo id）；按名字找号得走 Python API 的 `client.search(query, page, main_tag, order_by, time, category, sub_category)`——**7 个位置参数必须全给**，少给报 `TypeError: JmApiClient.search() missing 5 required positional arguments`。而搜索结果是 `(号, 标题)` 的 tuple，要标签还得再 `get_album_detail` 取一次（所以一次 search 会慢上十几二十秒）。

## 许可

MIT。PDF 拼装模块改自「漫画下载」QQ 桥接插件（同作者的 `comic-pdf.js`），
其思路是 JPEG 直通 + Pillow 兜底，这里只是把写死的路径去掉、验收逻辑保留。

下载内容的版权归原作者所有；本插件只提供工具，不做任何再分发。
