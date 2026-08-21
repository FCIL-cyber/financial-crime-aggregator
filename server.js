const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');
const cheerio = require('cheerio');
const axios = require('axios');
const cron = require('node-cron');
const { Pool } = require('pg');

const app = express();

// --- MIDDLEWARE SETUP (REQUIRED FOR JSON BODY PARSING) ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml; q=0.1'
  }
});

const verifyAdmin = (req, res, next) => {
  const apiKey = req.headers['x-admin-key'];
  if (!apiKey || apiKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Admin Key' });
  }
  next();
};

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
        is_deleted BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE articles ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
    `);
  } catch (err) {
    console.error('[DB Init Error]:', err.message);
  }
}
initDatabase();

// Master Feed List
const FEED_URLS = [
  'https://www.occrp.org/en/feed',
  'https://www.icij.org/feed/',
  'https://www.bellingcat.com/feed',
  'https://transparency.ie/taxonomy/term/5/feed',
  'https://fcil.substack.com/feed',
  'https://taxjustice.net/feed/',
  'https://corporateeurope.org/en/rss.xml',
  'https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=financial-crimes-enforcement-network',
  'https://www.gov.uk/government/organisations/serious-fraud-office.atom',
  'https://www.gov.uk/government/organisations/national-crime-agency.atom',
  'https://www.sec.gov/rss/news/press.xml',
  'https://news.google.com/rss/search?q=site:justice.gov+press+releases&hl=en-US&gl=US&ceid=US:en',
  'https://www.eppo.europa.eu/node/2/rss_en',
  'https://www.europol.europa.eu/cms/api/rss/news',
  'https://news.google.com/rss/search?q=site:investigate-europe.eu&hl=en-US&gl=US&ceid=US:en',
  'https://www.eurojust.europa.eu/rss/publications.xml',
  'https://www.eurojust.europa.eu/rss/press-releases.xml'
];

const FALLBACK_IMAGES = [
  'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1450133064473-71024230f91b?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1507679799987-c73779587ccf?auto=format&fit=crop&w=600&q=80'
];

const DOJ_IMAGES = [
  'https://upload.wikimedia.org/wikipedia/commons/thumb/5/54/Seal_of_the_United_States_Department_of_Justice.svg/960px-Seal_of_the_United_States_Department_of_Justice.svg.png',
  'https://upload.wikimedia.org/wikipedia/commons/thumb/0/00/Flag_of_the_United_States_Department_of_Justice.svg/1024px-Flag_of_the_United_States_Department_of_Justice.svg.png',
  'https://images.pexels.com/photos/9685285/pexels-photo-9685285.jpeg',
  'https://images.pexels.com/photos/6065255/pexels-photo-6065255.jpeg',
  'https://images.pexels.com/photos/36060296/pexels-photo-36060296.jpeg',
  'https://images.pexels.com/photos/17718824/pexels-photo-17718824.jpeg',
  'https://images.pexels.com/photos/14844457/pexels-photo-14844457.jpeg',
  'https://images.pexels.com/photos/19054772/pexels-photo-19054772.jpeg',
  'https://images.pexels.com/photos/6077123/pexels-photo-6077123.jpeg',
  'https://images.unsplash.com/photo-1688956020469-50f4ecef7489?q=80&w=1094&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
  'https://images.unsplash.com/photo-1698584200770-3838c3690a27?q=80&w=715&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
  'https://images.unsplash.com/photo-1688956020469-50f4ecef7489?q=80&w=1094&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
  'https://images.unsplash.com/photo-1744130400729-c4aee523f490?q=80&w=1632&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
  'https://images.unsplash.com/photo-1515606378517-3451a4fa2e12?q=80&w=1528&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
  'https://images.unsplash.com/photo-1514108225820-2b602873ac36?q=80&w=1631&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
  'https://images.unsplash.com/photo-1443110189928-4448af4a2bc5?q=80&w=993&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
  'https://images.unsplash.com/photo-1634038971336-9c105b3116e7?q=80&w=1567&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
  'https://images.unsplash.com/photo-1574607524755-56493b242d28?q=80&w=735&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
  'https://images.unsplash.com/photo-1595654378985-92061e59a24d?q=80&w=735&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
  'https://images.unsplash.com/photo-1609520612886-51b20d8c9ea5?q=80&w=764&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
  'https://images.unsplash.com/photo-1597699401213-82936bb3ec7c?q=80&w=687&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
  'https://images.unsplash.com/photo-1671469903138-d45f9f6aef89?q=80&w=687&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
  'https://images.unsplash.com/photo-1608500071261-4ca08a2a3b68?q=80&w=880&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D'
];

function getTopicImage(title, index, source = '') {
  const t = (title || '').toLowerCase();
  const s = (source || '').toLowerCase();

  if (s === 'doj (us)' || t.includes('department of justice') || t.includes('doj')) {
    const randomIndex = Math.floor(Math.random() * DOJ_IMAGES.length);
    return DOJ_IMAGES[randomIndex];
  }

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
    const host = parsedUrl.hostname.toLowerCase();

    if (host.includes('europol')) return 'EUROPOL';
    if (host.includes('eppo')) return 'EPPO (EU)';
    if (host.includes('eurojust')) return 'EUROJUST';
    if (host.includes('occrp')) return 'OCCRP';
    if (host.includes('icij')) return 'ICIJ';
    if (host.includes('bellingcat')) return 'BELLINGCAT';
    if (host.includes('transparency')) return 'TRANSPARENCY INT';
    if (host.includes('substack')) return 'FCIL SUBSTACK';
    if (host.includes('federalregister')) return 'FINCEN (FED REG)';
    if (host.includes('sec.gov')) return 'SEC (US)';
    if (host.includes('justice.gov')) return 'DOJ (US)';
    if (host.includes('taxjustice')) return 'TAX JUSTICE NET';
    if (host.includes('pogo.org')) return 'POGO';
    if (host.includes('corporateeurope')) return 'CORP EUROPE OBS';
    if (host.includes('investigate-europe')) return 'INVESTIGATE EUROPE';
    if (host.includes('gov.uk')) return 'GOV.UK';

    if (host.includes('google')) {
      const titleLower = (feedTitle || '').toLowerCase();
      if (titleLower.includes('investigate-europe')) return 'INVESTIGATE EUROPE';
      if (titleLower.includes('justice.gov') || titleLower.includes('doj')) return 'DOJ (US)';
      if (item.source && typeof item.source === 'string') return item.source.toUpperCase();
    }

    let cleanHost = host.replace(/^www\./, '');
    let parts = cleanHost.split('.');
    let brand = parts.length > 2 ? parts[parts.length - 2] : parts[0];
    if (brand && brand.length > 2) return brand.toUpperCase();

  } catch (e) {}

  return feedTitle ? feedTitle.replace(/"|-|Google|News|RSS|Feed|Latest/gi, '').trim().toUpperCase() : 'INTELLIGENCE';
}

// Ingestion Worker
async function runIngestionWorker() {
  console.log('[CRON] Scraping RSS feeds...');

  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

  for (const url of FEED_URLS) {
    try {
      let feed;

      if (url.includes('sec.gov') || url.includes('eppo.europa.eu') || url.includes('europol.europa.eu') || url.includes('eurojust.europa.eu')) {
        const { data: xmlData } = await axios.get(url, {
          headers: {
            'User-Agent': 'FinancialCrimeDashboard admin@dashboardapp.com',
            'Accept': 'application/xml, text/xml, application/rss+xml, */*'
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

        const isDoj = url.includes('justice.gov') || source === 'DOJ (US)';
        if (isDoj) {
          const titleUpper = title.toUpperCase();
          const keywords = ['$', 'FRAUD', 'LAUNDERING', 'LAUNDER', 'TAX', 'EVASION', 'BRIBERY', 'CORRUPTION', 'EMBEZZLE', 'EMBEZZLEMENT', 'SANCTION'];
          const hasKeyword = keywords.some(keyword => titleUpper.includes(keyword));
          if (!hasKeyword) continue;
        }

        let image = getFeedImage(item, idx);

        const isGoogle = link.includes('news.google.com') || (image && (image.includes('googleusercontent.com') || image.includes('ggpht.com')));

        if (!isGoogle && !image && link && !url.includes('sec.gov')) {
          const ogImg = await fetchOgImage(link);
          if (ogImg) image = ogImg;
        }

        if (isGoogle || !image) {
          image = getTopicImage(title, idx, source);
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

    const countResult = await pool.query('SELECT COUNT(*) FROM articles WHERE is_deleted = FALSE;');
    const totalArticles = parseInt(countResult.rows[0].count, 10);

    const articlesQuery = `
      SELECT 
        id, 
        title, 
        link, 
        TO_CHAR(published_at, 'Mon DD, YYYY') as date, 
        source, 
        image_url as image
      FROM articles
      WHERE is_deleted = FALSE
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

// ADMIN: DELETE A CARD BY ID
app.delete('/api/admin/articles/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE articles SET is_deleted = TRUE WHERE id = $1 RETURNING *;', 
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Article not found' });
    }

    res.json({ message: 'Card hidden successfully', deleted: result.rows[0] });
  } catch (err) {
    console.error('[Delete Error]:', err.message);
    res.status(500).json({ error: 'Failed to delete article' });
  }
});

// ADMIN: ADD A CUSTOM CARD
app.post('/api/admin/articles', verifyAdmin, async (req, res) => {
  try {
    const { title, link, source, image_url, published_at } = req.body;

    if (!title || !link) {
      return res.status(400).json({ error: 'Title and Link are required' });
    }

    const guid = `manual-${Date.now()}`;
    const pubDate = published_at ? new Date(published_at) : new Date();

    const insertQuery = `
      INSERT INTO articles (guid, title, link, published_at, source, image_url)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;

    const values = [
      guid,
      title,
      link,
      pubDate,
      source || 'MANUAL BRIEF',
      image_url || 'https://images.unsplash.com/photo-1450133064473-71024230f91b?auto=format&fit=crop&w=600&q=80'
    ];

    const result = await pool.query(insertQuery, values);
    res.status(201).json({ message: 'Card created successfully', article: result.rows[0] });
  } catch (err) {
    console.error('[Add Card Error]:', err.message);
    res.status(500).json({ error: 'Failed to insert custom card' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));