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

// Health check route for keep-alive pings
app.get('/', (req, res) => {
  res.send('FCIL Aggregator API is running smoothly.');
});

// Targeted Financial Crime & Investigative Feeds
const FEED_URLS = [
  'https://www.finextra.com/rss/topic/crime',
  'https://www.occ.gov/rss/news-releases.xml',
  'https://www.icij.org/feed/',
  'https://gijn.org/feed/'
];

// Fallback images only used if NO image exists in XML/HTML
const FALLBACK_IMAGES = [
  'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1450133064473-71024230f91b?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1507679799987-c73779587ccf?auto=format&fit=crop&w=600&q=80'
];

// Thorough XML & HTML Image Extraction
function getFeedImage(item, index) {
  // 1. Direct XML Media Enclosures
  if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) return item.mediaContent.$.url;
  if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) return item.mediaThumbnail.$.url;
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;

  // 2. Parse embedded <img> tags inside content/description HTML payload
  const rawHtml = item.contentEncoded || item.content || item.summary || item.description || '';
  if (rawHtml) {
    try {
      const $ = cheerio.load(rawHtml);
      const imgSrc = $('img').first().attr('src');
      if (imgSrc && imgSrc.startsWith('http')) {
        return imgSrc;
      }
    } catch (e) {
      // Ignore parse error and fall through
    }
  }

  // 3. Fallback stock photo if no article image is available
  return FALLBACK_IMAGES[index % FALLBACK_IMAGES.length];
}

// Strictly prioritize Publication Brand over Author Name
function getCardSource(item, feedTitle, articleLink) {
  // 1. First, parse domain name to get the publication brand
  try {
    const parsedUrl = new URL(articleLink);
    let host = parsedUrl.hostname.replace(/^www\./, '');
    let parts = host.split('.');
    let brand = parts.length > 2 ? parts[parts.length - 2] : parts[0];

    const brandMap = {
      'fincen': 'FINCEN',
      'finextra': 'FINEXTRA',
      'fatf-gafi': 'FATF',
      'occ': 'OCC',
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
    // Fall through to author/feed title if URL parsing fails
  }

  // 2. Fallback to Feed Title or Author
  if (feedTitle) {
    return feedTitle.replace(/RSS|Feed|News|Latest/gi, '').trim().toUpperCase();
  }

  return 'INTELLIGENCE';
}

app.get('/api/news', async (req, res) => {
  try {
    const feedPromises = FEED_URLS.map(async (url) => {
      try {
        const feed = await parser.parseURL(url);
        
        return feed.items.slice(0, 10).map((item, idx) => {
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

    // Sort chronologically (newest first)
    allArticles.sort((a, b) => b.rawDate - a.rawDate);

    res.json(allArticles);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));