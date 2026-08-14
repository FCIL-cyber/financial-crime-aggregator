const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();

// Configured Parser with 10s timeout and Custom User-Agent to handle RSS bridges safely
const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml; q=0.1'
  },
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail'],
      ['enclosure', 'enclosure'],
      ['content:encoded', 'contentEncoded'],
      ['dc:creator', 'dcCreator'],
      ['author', 'author']
    ]
  }
});

const PORT = process.env.PORT || 3000;
app.use(cors());

// Global Memory Cache variables
let articleCache = [];
let lastFetchTime = 0;
const CACHE_DURATION = 15 * 60 * 1000; // 15 minutes in milliseconds

// Target Financial Crime & Investigative Reporting Feeds
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

// Fallback high-res stock images
const FALLBACK_IMAGES = [
  'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1450133064473-71024230f91b?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1507679799987-c73779587ccf?auto=format&fit=crop&w=600&q=80'
];

// Health check route
app.get('/', (req, res) => {
  res.send('FCIL Aggregator API is running smoothly.');
});

// XML & HTML Image Extraction
function getFeedImage(item, index) {
  if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) return item.mediaContent.$.url;
  if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) return item.mediaThumbnail.$.url;
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;

  const rawHtml = item.contentEncoded || item.content || item.summary || item.description || '';
  if (rawHtml) {
    try {
      const $ = cheerio.load(rawHtml);
      const imgSrc = $('img').first().attr('src');
      if (imgSrc && imgSrc.startsWith('http')) {
        return imgSrc;
      }
    } catch (e) {
      // Ignore HTML parse errors and fall through
    }
  }

  return FALLBACK_IMAGES[index % FALLBACK_IMAGES.length];
}

// Brand Extraction via Article URL Domain & Feed Context
function getCardSource(item, feedTitle, articleLink) {
  try {
    const parsedUrl = new URL(articleLink);
    let host = parsedUrl.hostname.replace(/^www\./, '');
    let parts = host.split('.');
    let brand = parts.length > 2 ? parts[parts.length - 2] : parts[0];

    // Standard Direct Domain Mappings
    const brandMap = {
      'occrp': 'OCCRP',
      'icij': 'ICIJ',
      'transparency': 'TRANSPARENCY INT',
      'substack': 'FCIL SUBSTACK',
      'bellingcat': 'BELLINGCAT',
      'federalregister': 'FINCEN (FED REG)',
      'thebureauinvestigates': 'THE BUREAU'
    };

    if (brand !== 'google' && brandMap[brand.toLowerCase()]) {
      return brandMap[brand.toLowerCase()];
    }

    // Handle Google News RSS feeds dynamically based on Feed Title or Item Source
    if (brand === 'google' || host.includes('google')) {
      const titleLower = (feedTitle || '').toLowerCase();
      
      if (titleLower.includes('thebureauinvestigates') || titleLower.includes('bureau')) {
        return 'THE BUREAU';
      }
      if (titleLower.includes('transparency')) {
        return 'TRANSPARENCY INT';
      }
      if (item.source && typeof item.source === 'string') {
        return item.source.toUpperCase();
      }
    }

    if (brand && brand !== 'google' && brand.length > 2) {
      return brand.toUpperCase();
    }
  } catch (e) {
    // Fall through if domain parsing fails
  }

  return feedTitle ? feedTitle.replace(/"|-|Google|News|RSS|Feed|Latest/gi, '').trim().toUpperCase() : 'INTELLIGENCE';
}

// In-Memory Scraping & Caching Engine
async function refreshArticleCache() {
  try {
    console.log('Fetching updated intelligence feeds...');
    const feedPromises = FEED_URLS.map(async (url) => {
      try {
        const feed = await parser.parseURL(url);
        
        return feed.items.map((item, idx) => ({
          title: item.title,
          link: item.link,
          date: item.pubDate 
            ? new Date(item.pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) 
            : 'Recent',
          rawDate: item.pubDate ? new Date(item.pubDate) : new Date(0),
          source: getCardSource(item, feed.title, item.link),
          image: getFeedImage(item, idx)
        }));
      } catch (err) {
        console.error(`Error fetching feed [${url}]:`, err.message);
        return [];
      }
    });

    const results = await Promise.all(feedPromises);
    let allArticles = results.flat();

    // 1. Keep only articles published within the last 14 days
    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
    allArticles = allArticles.filter(item => item.rawDate >= fourteenDaysAgo);

    // 2. Sort chronologically (newest first)
    allArticles.sort((a, b) => b.rawDate - a.rawDate);

    // 3. Save to global memory cache
    articleCache = allArticles;
    lastFetchTime = Date.now();
    console.log(`Cache successfully updated: ${articleCache.length} articles retained from past 14 days.`);
  } catch (err) {
    console.error('Error refreshing cache:', err.message);
  }
}

// Aggregated & Paginated API Endpoint
app.get('/api/news', async (req, res) => {
  try {
    // Fetch live feeds only if cache is empty or older than 15 minutes
    if (!articleCache.length || (Date.now() - lastFetchTime > CACHE_DURATION)) {
      await refreshArticleCache();
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 12;
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;

    const paginatedArticles = articleCache.slice(startIndex, endIndex);

    res.json({
      totalArticles: articleCache.length,
      totalPages: Math.ceil(articleCache.length / limit),
      currentPage: page,
      articles: paginatedArticles
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve news' });
  }
});

// Diagnostic Endpoint: Detailed Source Article Breakdown
app.get('/api/debug-sources', async (req, res) => {
  try {
    if (!articleCache.length || (Date.now() - lastFetchTime > CACHE_DURATION)) {
      await refreshArticleCache();
    }

    const breakdown = articleCache.reduce((acc, article) => {
      acc[article.source] = (acc[article.source] || 0) + 1;
      return acc;
    }, {});

    res.json({
      lastFetchTime: new Date(lastFetchTime).toISOString(),
      totalArticles: articleCache.length,
      sourceBreakdown: breakdown
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to inspect sources' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));