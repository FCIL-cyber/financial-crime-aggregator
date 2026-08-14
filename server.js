const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');
const cheerio = require('cheerio');
const axios = require('axios');
const cron = require('node-cron');
const { Pool } = require('pg');

const app = express();
const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml; q=0.1'
  }
});

app.use(cors());
const PORT = process.env.PORT || 3000;

// Connect to Supabase Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') 
    ? false 
    : { rejectUnauthorized: false }
});

// Create Table
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS articles (
        id SERIAL PRIMARY KEY,
        guid TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        link TEXT NOT NULL,
        published_at TIMESTAMP WITH TIME ZONE NOT NULL,
        source TEXT NOT NULL,
        image_url TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (err) {
    console.error('[DB Init Error]:', err.message);
  }
}
initDatabase();

const FEED_URLS = [
  'https://www.occrp.org/en/feed',
  'https://www.icij.org/feed/',
  'https://transparency.ie/taxonomy/term/5/feed',
  'https://fcil.substack.com/feed',
  'https://www.bellingcat.com/feed',
  'https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=financial-crimes-enforcement-network',
  'https://news.google.com/rss/search?q=%22Transparency+International%22&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=site:thebureauinvestigates.com&hl=en-US&gl=US&ceid=US:en'
];

const FALLBACK_IMAGES = [
  'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1450133064473-71024230f91b?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1507679799987-c73779587ccf?auto=format&fit=crop&w=600&q=80'
];

function getFeedImage(item, index) {
  if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) return item.mediaContent.$.url;
  if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) return item.mediaThumbnail.$.url;
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;

  const rawHtml = item.contentEncoded || item.content || item.summary || item.description || '';
  if (rawHtml) {
    try {
      const $ = cheerio.load(rawHtml);
      const imgSrc = $('img').first().attr('src');
      if (imgSrc && imgSrc.startsWith('http')) return imgSrc;
    } catch (e) {}
  }
  return FALLBACK_IMAGES[index % FALLBACK_IMAGES.length];
}

async function fetchOgImage(url) {
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 3000
    });
    const $ = cheerio.load(data);
    return $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || null;
  } catch (e) {
    return null;
  }
}

function getCardSource(item, feedTitle, articleLink) {
  try {
    const parsedUrl = new URL(articleLink);
    let host = parsedUrl.hostname.replace(/^www\./, '');
    let parts = host.split('.');
    let brand = parts.length > 2 ? parts[parts.length - 2] : parts[0];

    const brandMap = {
      'occrp': 'OCCRP',
      'icij': 'ICIJ',
      'transparency': 'TRANSPARENCY INT',
      'substack': 'FCIL SUBSTACK',
      'bellingcat': 'BELLINGCAT',
      'federalregister': 'FINCEN (FED REG)',
      'thebureauinvestigates': 'THE BUREAU'
    };

    if (brand !== 'google' && brandMap[brand.toLowerCase()]) return brandMap[brand.toLowerCase()];

    if (brand === 'google' || host.includes('google')) {
      const titleLower = (feedTitle || '').toLowerCase();
      if (titleLower.includes('thebureauinvestigates') || titleLower.includes('bureau')) return 'THE BUREAU';
      if (titleLower.includes('transparency')) return 'TRANSPARENCY INT';
      if (item.source && typeof item.source === 'string') return item.source.toUpperCase();
    }

    if (brand && brand !== 'google' && brand.length > 2) return brand.toUpperCase();
  } catch (e) {}

  return feedTitle ? feedTitle.replace(/"|-|Google|News|RSS|Feed|Latest/gi, '').trim().toUpperCase() : 'INTELLIGENCE';
}

// Background Ingestion Worker
async function runIngestionWorker() {
  console.log('[CRON] Scraping RSS feeds...');

  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

  for (const url of FEED_URLS) {
    try {
      const feed = await parser.parseURL(url);

      for (let idx = 0; idx < (feed.items || []).length; idx++) {
        const item = feed.items[idx];
        const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();

        if (pubDate < fourteenDaysAgo) continue;

        const guid = item.guid || item.link;
        const link = item.link || '#';
        const title = item.title || 'Untitled Article';
        const source = getCardSource(item, feed.title, link);

        let image = getFeedImage(item, idx);

        if (FALLBACK_IMAGES.includes(image) && link && !link.includes('news.google.com')) {
          const ogImg = await fetchOgImage(link);
          if (ogImg) image = ogImg;
        }

        const insertQuery = `
          INSERT INTO articles (guid, title, link, published_at, source, image_url)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (guid) DO NOTHING;
        `;
        await pool.query(insertQuery, [guid, title, link, pubDate, source, image]);
      }
    } catch (err) {
      console.error(`[CRON Error] ${url}:`, err.message);
    }
  }

  // Purge older than 14 days
  try {
    await pool.query("DELETE FROM articles WHERE published_at < NOW() - INTERVAL '14 days';");
  } catch (deleteErr) {}
}

cron.schedule('*/15 * * * *', () => runIngestionWorker());
runIngestionWorker();

app.get('/', (req, res) => res.send('Server is live'));

// Restored API Endpoint supporting BOTH Pagination OR Raw Array
app.get('/api/news', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    // Set limit per page (defaults to 12 or whatever req.query.limit sends, max cap 16)
    const limit = parseInt(req.query.limit) || 12;
    const offset = (page - 1) * limit;

    const countResult = await pool.query('SELECT COUNT(*) FROM articles;');
    const totalArticles = parseInt(countResult.rows[0].count, 10);

    const articlesQuery = `
      SELECT 
        title, 
        link, 
        TO_CHAR(published_at, 'Mon DD, YYYY') as date, 
        source, 
        image_url as image
      FROM articles
      ORDER BY published_at DESC
      LIMIT $1 OFFSET $2;
    `;
    const articlesResult = await pool.query(articlesQuery, [limit, offset]);

    // Checks how frontend requests data (paginated object vs direct array)
    if (req.query.page || req.query.limit) {
      res.json({
        totalArticles,
        totalPages: Math.ceil(totalArticles / limit) || 1,
        currentPage: page,
        articles: articlesResult.rows
      });
    } else {
      // If frontend asks for plain array, cap it to limit (12/16)
      res.json(articlesResult.rows.slice(0, limit));
    }
  } catch (error) {
    console.error('[API Error]:', error.message);
    res.status(500).json({ error: 'Failed to retrieve news' });
  }
});

// Debug route to inspect source breakdown
app.get('/api/debug-sources', async (req, res) => {
  try {
    const result = await pool.query('SELECT source, COUNT(*) as count FROM articles GROUP BY source;');
    const breakdown = {};
    result.rows.forEach(row => breakdown[row.source] = parseInt(row.count, 10));
    res.json({ 
      totalArticles: Object.values(breakdown).reduce((a, b) => a + b, 0), 
      sourceBreakdown: breakdown 
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to inspect sources' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));