const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const DATA_FILE      = path.join(__dirname, '..', 'data.json');
const MAX_NEWS       = 50;   // articles to keep in data.json
const MAX_BODY_CHARS = 2000; // chars of article text to store per article
const MAX_FETCH      = 20;   // max new articles to fetch bodies for per run
const FETCH_DELAY_MS = 800;  // pause between article fetches (be polite)

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { last_updated: null, targets: [], news: [] }; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchUrl(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchUrl(next, timeoutMs).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, url }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Extract readable article text from HTML — no dependencies needed
function extractArticleText(html) {
  // Strip noisy sections
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Pull text from <p> tags — most article body lives here
  const paragraphs = [];
  for (const m of clean.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = m[1]
      .replace(/<[^>]+>/g, '')   // strip remaining tags
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 50) paragraphs.push(text);
  }

  const body = paragraphs.join(' ').slice(0, MAX_BODY_CHARS);
  return body || null;
}

function extractCDATA(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return null;
  return (m[1] !== undefined ? m[1] : m[2] || '').trim();
}

function extractAttrText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#\d+;/g, '');
}

function cleanTitle(raw) {
  return decodeEntities(raw).replace(/ - [^-]{1,40}$/, '').trim();
}

function stableId(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) + h) ^ str.charCodeAt(i); h >>>= 0; }
  return h.toString(36);
}

async function fetchGoogleNewsRSS(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const { body } = await fetchUrl(url);
    const items = [];
    for (const m of body.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const xml   = m[1];
      const title = extractCDATA(xml, 'title');
      const link  = extractCDATA(xml, 'link') || extractAttrText(xml, 'link') || extractCDATA(xml, 'guid');
      const date  = extractCDATA(xml, 'pubDate');
      const src   = extractAttrText(xml, 'source') || extractCDATA(xml, 'source');
      if (title && link) {
        const t = cleanTitle(title);
        items.push({ id: stableId(t + link), title: t, link: link.trim(), date: date ? new Date(date).toISOString() : new Date().toISOString(), source: src || 'Google News', body: null });
      }
    }
    return items;
  } catch(e) {
    console.warn(`  RSS failed (${query}):`, e.message);
    return [];
  }
}

async function fetchArticleBody(item) {
  try {
    const { body, url: finalUrl } = await fetchUrl(item.link, 12000);
    const text = extractArticleText(body);
    if (text && text.length > 100) {
      console.log(`    ✓ ${item.title.slice(0, 60)}...`);
      return text;
    }
    console.log(`    ~ No usable text: ${item.title.slice(0, 50)}`);
    return null;
  } catch(e) {
    console.log(`    ✗ Failed (${e.message.slice(0, 40)}): ${item.title.slice(0, 40)}`);
    return null;
  }
}

async function main() {
  console.log('=== Kentucky Transfer Portal Scraper ===');
  console.log('Run time:', new Date().toUTCString());

  const existing   = loadData();
  const existingMap = new Map((existing.news || []).map(n => [n.id, n]));

  const queries = [
    'Kentucky Wildcats basketball transfer portal',
    'Kentucky basketball transfer 2025',
    '"Mark Pope" transfer portal'
  ];

  const allItems = [];
  for (const q of queries) {
    console.log(`\nFetching RSS: "${q}"...`);
    const items = await fetchGoogleNewsRSS(q);
    console.log(`  → ${items.length} items`);
    allItems.push(...items);
  }

  // Deduplicate
  const seen = new Set();
  const deduped = allItems.filter(n => { if (seen.has(n.id)) return false; seen.add(n.id); return true; });

  // Split into new vs existing (preserve existing body text)
  const newItems = deduped.filter(n => !existingMap.has(n.id));
  const oldItems = deduped.filter(n => existingMap.has(n.id)).map(n => existingMap.get(n.id));

  console.log(`\nNew articles: ${newItems.length}`);

  // Fetch article bodies for new items (up to MAX_FETCH)
  const toFetch = newItems.slice(0, MAX_FETCH);
  if (toFetch.length > 0) {
    console.log(`\nFetching article bodies for ${toFetch.length} articles...`);
    for (const item of toFetch) {
      item.body = await fetchArticleBody(item);
      await sleep(FETCH_DELAY_MS);
    }
    const withBody = toFetch.filter(n => n.body).length;
    console.log(`\nSuccessfully fetched body for ${withBody}/${toFetch.length} articles`);
  }

  // Also try to fetch bodies for older articles that don't have one yet
  const missingBody = oldItems.filter(n => !n.body).slice(0, 5);
  if (missingBody.length > 0) {
    console.log(`\nRetrying body fetch for ${missingBody.length} older articles...`);
    for (const item of missingBody) {
      item.body = await fetchArticleBody(item);
      await sleep(FETCH_DELAY_MS);
    }
  }

  const merged = [...newItems, ...oldItems]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_NEWS);

  const withBodies = merged.filter(n => n.body).length;
  console.log(`\nTotal articles: ${merged.length} (${withBodies} with full text)`);

  fs.writeFileSync(DATA_FILE, JSON.stringify({
    last_updated: new Date().toISOString(),
    targets: existing.targets || [],
    news: merged
  }, null, 2));

  console.log('data.json updated successfully');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
