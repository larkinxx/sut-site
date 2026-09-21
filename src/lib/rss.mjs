// Разбор RSS 2.0 и Atom без внешних библиотек.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENT ? ENT[n.toLowerCase()] : m));
}

export function stripHtml(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|br)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  v = cdata ? cdata[1] : decodeEntities(v);
  return v.trim();
}

// Возвращает [{ title, link, guid, pubDate (ISO|null), text }]
export function parseFeed(xml) {
  const items = [];
  const rss = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const b of rss) {
    const link = tag(b, 'link') || tag(b, 'guid');
    const d = Date.parse(tag(b, 'pubDate') || tag(b, 'dc:date'));
    items.push({
      title: stripHtml(tag(b, 'title')),
      link,
      guid: tag(b, 'guid') || link,
      pubDate: Number.isNaN(d) ? null : new Date(d).toISOString(),
      text: stripHtml(tag(b, 'description') || tag(b, 'content:encoded'))
    });
  }
  if (!items.length) {
    for (const b of xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []) {
      const href = (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
      const d = Date.parse(tag(b, 'published') || tag(b, 'updated'));
      items.push({
        title: stripHtml(tag(b, 'title')),
        link: decodeEntities(href),
        guid: tag(b, 'id') || href,
        pubDate: Number.isNaN(d) ? null : new Date(d).toISOString(),
        text: stripHtml(tag(b, 'summary') || tag(b, 'content'))
      });
    }
  }
  return items.filter((i) => i.title && /^https?:\/\//.test(i.link));
}

export function decodeBody(buf, contentType = '') {
  const head = Buffer.from(buf.subarray(0, 200)).toString('latin1');
  const enc =
    (contentType.match(/charset=([\w-]+)/i) || [])[1] ||
    (head.match(/encoding=["']([\w-]+)["']/i) || [])[1] ||
    'utf-8';
  try {
    return new TextDecoder(enc).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}
