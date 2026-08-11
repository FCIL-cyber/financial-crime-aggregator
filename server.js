const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();
const parser = new Parser({
  timeout: 4000,
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
  'https://www.finextra.com/rss/channel.aspx?channel=crime',
  'https://www.occrp.org/en/feed',
  'https://www.icij.org/feed/',
  'https://gijn.org/feed/',
  'https://eng.lsm.lv/rss/?lang=en&catid=21653'
];

// Fallback high-res stock images
const FALLBACK_IMAGES = [
  'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1450133064473-71024230f91b?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1507679799987-c73779587ccf?auto=format&fit=crop&w=600&q=80'
];

// Health check route for keep-alive pings
app.get('/', (req, res) => {
  res.send('FCIL Aggregator API is running smoothly.');
});

// Thorough XML & HTML Image Extraction
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

// Brand Extraction via Article URL Domain
function getCardSource(item, feedTitle, articleLink) {
  try {
    const parsedUrl = new URL(articleLink);
    let host = parsedUrl.hostname.replace(/^www\./, '');
    let parts = host.split('.');
    let brand = parts.length > 2 ? parts[parts.length - 2] : parts[0];

    const brandMap = {
      'finextra': 'FINEXTRA',
      'occrp': 'OCCRP',
      'icij': 'ICIJ',
      'gijn': 'GIJN'
    };

    if (brandMap[brand.toLowerCase()]) {
      return brandMap[brand.toLowerCase()];
    }

    if (brand && brand.length > 2) {
      return brand.toUpperCase();
    }
  } catch (e) {
    // Fall through if domain parsing fails
  }

  return feedTitle ? feedTitle.replace(/RSS|Feed|News|Latest/gi, '').trim().toUpperCase() : 'INTELLIGENCE';
}

// In-Memory Scraping & Caching Engine
async function refreshArticleCache() {
  try {
    const feedPromises = FEED_URLS.map(async (url) => {
      try {
        const feed = await parser.parseURL(url);
        
        return feed.items.map((item, idx) => {
          return {
            title: item.title,
            link: item.link,
            date: item.pubDate 
              ? new Date(item.pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) 
              : 'Recent',
            rawDate: item.pubDate ? new Date(item.pubDate) : new Date(0),
            source: getCardSource(item, feed.title, item.link),
            image: getFeedImage(item, idx)
          };
        });
      } catch (err) {
        console.error(`Error fetching feed ${url}:`, err.message);
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
    console.log(`Cache updated: ${articleCache.length} articles stored.`);
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

    // Pagination query parameters (e.g., /api/news?page=1&limit=12)
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));