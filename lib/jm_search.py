# lib/jm_search.py — 按书名搜本子，把结果整理成 JSON 交给 Node 侧。
#
# 为什么单独一个脚本文件而不是 `python -c`：
#   1) 这段代码一百来行，塞进命令行会被 Windows 的引号与编码折腾死；
#   2) 中文关键词作为 argv 传进来本身就是 UTF-8，脚本文件用 utf-8 存就不会乱码。
#
# 输出约定：先关掉 jmcomic 自己的 log，最后打印一行 `###RESULT###<json>`。
# Node 侧只认这一行——日志里出现任何意外字符都不会污染解析。
import json
import sys


def _strings(value):
    """把各种字段统一成字符串列表（有的字段是 None，有的可能是单个字符串）。"""
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    try:
        return [str(item).strip() for item in value if str(item).strip()]
    except TypeError:
        return [str(value)]


def main():
    query = sys.argv[1] if len(sys.argv) > 1 else ''
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 20

    from jmcomic import JmOption

    try:
        from jmcomic import disable_jm_log
        disable_jm_log()
    except Exception:
        pass

    option = JmOption.default()
    client = option.new_jm_client()

    # search(query, page, main_tag, order_by, time, category, sub_category)
    # order_by='mr' 是站点的「最新」，time='a' 不限时间。
    page = client.search(query, 1, 0, 'mr', 'a', None, None)

    items = []
    for entry in page:
        if isinstance(entry, (tuple, list)) and len(entry) >= 2:
            album_id, title = str(entry[0]), str(entry[1])
        else:
            album_id, title = str(getattr(entry, 'album_id', '')), str(getattr(entry, 'title', ''))
        record = {
            'album_id': album_id,
            'title': title,
            'authors': [],
            'works': [],
            'tags': [],
            'actors': [],
            'page_count': 0,
            'pub_date': '',
            'views': '',
            'description': '',
            'cover': '',
            'error': '',
        }
        # 搜索结果页只给号与标题，标签/作者得再取一次详情。
        try:
            from jmcomic import JmcomicText
            # 封面 URL 由本子号直接生成（不用再发请求）：搜索列表用的是 _3x4 竖版缩略图。
            record['cover'] = JmcomicText.get_album_cover_url(album_id, size='_3x4')
        except Exception:
            record['cover'] = ''
        try:
            detail = client.get_album_detail(album_id)
            record['title'] = str(getattr(detail, 'name', '') or title)
            record['authors'] = _strings(getattr(detail, 'authors', None))
            record['works'] = _strings(getattr(detail, 'works', None))
            record['tags'] = _strings(getattr(detail, 'tags', None))
            record['actors'] = _strings(getattr(detail, 'actors', None))
            record['page_count'] = int(getattr(detail, 'page_count', 0) or 0)
            record['pub_date'] = str(getattr(detail, 'pub_date', '') or '')
            record['views'] = str(getattr(detail, 'views', '') or '')
            record['description'] = str(getattr(detail, 'description', '') or '')[:300]
        except Exception as exc:  # 详情取不到也照样把号与标题交出去
            record['error'] = f'{type(exc).__name__}: {exc}'[:200]
        items.append(record)
        if len(items) >= limit:
            break

    sys.stdout.write('###RESULT###' + json.dumps(items, ensure_ascii=False) + '\n')
    sys.stdout.flush()


if __name__ == '__main__':
    main()
