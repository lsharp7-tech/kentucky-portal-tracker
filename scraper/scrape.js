const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { last_updated: null, targets: [], news: [] };
  }
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; UKPortalTracker/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      },
      timeout: 20000
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function extractCDATA(xml, tag) {
  // Match <tag><![CDATA[...]]></tag> or <tag>...</tag>
  const re = new RegExp(
    `<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/${tag}>`,
    'i'
  );
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
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#\d+;/g, '');
}

function cleanTitle(raw) {
  const decoded = decodeEntities(raw);
  // Google News appends " - Source Name" — strip it
  return decoded.replace(/ - [^-]{1,40}$/, '').trim();
}

function stableId(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h >>>= 0;
  }
  return h.toString(36);
}

async function fetchGoogleNewsRSS(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const { body } = await fetchUrl(url);
    const items = [];
    const matches = body.matchAll(/<item>([\s\S]*?)<\/item>/g);
    for (const m of matches) {
      const xml = m[1];
      const title = extractCDATA(xml, 'title');
      // Google encodes real URL in link tag or guid
      let link = extractCDATA(xml, 'link') || extractAttrText(xml, 'link') || extractCDATA(xml, 'guid');
      const pubDate = extractCDATA(xml, 'pubDate');
      const source = extractAttrText(xml, 'source') || extractCDATA(xml, 'source');
      if (title && link) {
        const cleanedTitle = cleanTitle(title);
        items.push({
          id: stableId(cleanedTitle + (link || '')),
          title: cleanedTitle,
          link: link.trim(),
          date: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
          source: source || 'Google News'
        });
      }
    }
    return items;
  } catch (e) {
    console.warn(`  RSS fetch failed (${query}):`, e.message);
    return [];
  }
}

async function main() {
  console.log('=== Kentucky Transfer Portal Scraper ===');
  console.log('Run time:', new Date().toUTCString());

  const existing = loadData();
  const existingIds = new Set((existing.news || []).map(n => n.id));

  // Multiple targeted queries for better coverage
  const queries = [
    'Kentucky Wildcats basketball transfer portal',
    'Kentucky basketball transfer 2025',
    '"Mark Pope" transfer portal'
  ];

  const allItems = [];
  for (const q of queries) {
    console.log(`Fetching: "${q}"...`);
    const items = await fetchGoogleNewsRSS(q);
    console.log(`  → ${items.length} items`);
    allItems.push(...items);
  }

  // Deduplicate across queries
  const seenIds = new Set();
  const deduped = allItems.filter(item => {
    if (seenIds.has(item.id)) return false;
    seenIds.add(item.id);
    return true;
  });

  const newItems = deduped.filter(n => !existingIds.has(n.id));
  console.log(`\nNew items since last run: ${newItems.length}`);

  // Sort all items newest first, keep latest 100
  const merged = [...newItems, ...(existing.news || [])]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 100);

  const data = {
    last_updated: new Date().toISOString(),
    targets: existing.targets || [],
    news: merged
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log(`\ndata.json updated — ${merged.length} total news items`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
