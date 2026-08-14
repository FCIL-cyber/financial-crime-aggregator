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

// Connect to Supabase
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') 
    ? false 
    : { rejectUnauthorized: false }
});

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

// Your exact requested feed list with SEC included
const FEED_URLS = [
  'https://www.occrp.org/en/feed',
  'https://www.icij.org/feed/',
  'https://www.bellingcat.com/feed',
  'https://transparency.ie/taxonomy/term/5/feed',
  'https://fcil.substack.com/feed',
  'https://taxjustice.net/feed/',
  'https://www.pogo.org/feed',
  'https://corporateeurope.org/en/rss.xml',
  'https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=financial-crimes-enforcement-network',
  'https://www.gov.uk/government/organisations/serious-fraud-office.atom',
  'https://www.gov.uk/government/organisations/national-crime-agency.atom',
  'https://www.sec.gov/rss/news/press.xml',
  'https://www.justice.gov/rss/opa/press-releases.xml'
];

const FALLBACK_IMAGES = [
  'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1450133064473-71024230f91b?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1507679799987-c73779587ccf?auto=format&fit=crop&w=600&q=80'
];

function getTopicImage(title, index) {
  const t = (title || '').toLowerCase();

  if (t.includes('court') || t.includes('law') || t.includes('judge') || t.includes('prosecut') || t.includes('trial') || t.includes('clash')) {
    return 'https://images.unsplash.com/photo-1589829545856-d10d557cf95f?auto=format&fit=crop&w=600&q=80';
  }
  if (t.includes('bank') || t.includes('treasury') || t.includes('money') || t.includes('tax') || t.includes('finance') || t.includes('corporate') || t.includes('transparency act')) {
    return 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=600&q=80';
  }
  if (t.includes('crime') || t.includes('fraud') || t.includes('corrupt') || t.includes('investig') || t.includes('scheme') || t.includes('erases')) {
    return 'https://images.unsplash.com/photo-1450133064473-71024230f91b?auto=format&fit=crop&w=600&q=80';
  }

  return FALLBACK_IMAGES[index % FALLBACK_IMAGES.length];
}

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
  return null;
}

async function fetchOgImage(url) {
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 4000
    });
    const $ = cheerio.load(data);
    return $('meta[property="og:image"]').attr('content') || 
           $('meta[name="twitter:image"]').attr('content') || null;
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
      'gov': 'GOV.UK',
      'sec': 'SEC (US)',
      'justice': 'DOJ (US)',
      'taxjustice': 'TAX JUSTICE NET',
      'pogo': 'POGO',
      'corporateeurope': 'CORP EUROPE OBS'
    };

    if (brandMap[brand.toLowerCase()]) return brandMap[brand.toLowerCase()];

    if (item.source && typeof item.source === 'string') return item.source.toUpperCase();
    if (brand && brand.length > 2) return brand.toUpperCase();
  } catch (e) {}

  return feedTitle ? feedTitle.replace(/"|-|Google|News|RSS|Feed|Latest/gi, '').trim().toUpperCase() : 'INTELLIGENCE';
}

// Ingestion Worker with custom SEC handler
async function runIngestionWorker() {
  console.log('[CRON] Scraping RSS feeds...');

  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

  for (const url of FEED_URLS) {
    try {
      let feed;

      // Handle SEC specifically with mandated User-Agent format
      if (url.includes('sec.gov')) {
        const { data: xmlData } = await axios.get(url, {
          headers: {
            'User-Agent': 'FinancialCrimeDashboard admin@dashboardapp.com',
            'Accept': 'application/xml, text/xml, */*'
          },
          timeout: 10000
        });
        feed = await parser.parseString(xmlData);
      } else {
        feed = await parser.parseURL(url);
      }

      for (let idx = 0; idx < (feed.items || []).length; idx++) {
        const item = feed.items[idx];
        const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();

        if (pubDate < fourteenDaysAgo) continue;

        const guid = item.guid || item.link;
        const link = item.link || '#';
        const title = item.title || 'Untitled Article';
        const source = getCardSource(item, feed.title, link);

        let image = getFeedImage(item, idx);

        if (!image && link && !url.includes('sec.gov')) {
          const ogImg = await fetchOgImage(link);
          if (ogImg) image = ogImg;
        }

        if (!image) {
          image = getTopicImage(title, idx);
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

  try {
    await pool.query("DELETE FROM articles WHERE published_at < NOW() - INTERVAL '14 days';");
  } catch (deleteErr) {}
}

cron.schedule('*/15 * * * *', () => runIngestionWorker());
runIngestionWorker();

app.get('/', (req, res) => res.send('Server is live'));

app.get('/api/news', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
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

    if (req.query.page || req.query.limit) {
      res.json({
        totalArticles,
        totalPages: Math.ceil(totalArticles / limit) || 1,
        currentPage: page,
        articles: articlesResult.rows
      });
    } else {
      res.json(articlesResult.rows.slice(0, limit));
    }
  } catch (error) {
    console.error('[API Error]:', error.message);
    res.status(500).json({ error: 'Failed to retrieve news' });
  }
});

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