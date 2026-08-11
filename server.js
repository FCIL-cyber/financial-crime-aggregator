const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');

const app = express();
const parser = new Parser({
  timeout: 3000,
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail'],
      ['enclosure', 'enclosure'],
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

// Primary Financial Crime & Investigative Journalism Feeds
const FEED_URLS = [
  'https://www.finextra.com/rss/topic/crime',
  'https://www.occ.gov/rss/news-releases.xml',
  'https://www.icij.org/feed/',
  'https://gijn.org/feed/'
];

// Fallback high-res stock images
const FALLBACK_IMAGES = [
  'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1450133064473-71024230f91b?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1507679799987-c73779587ccf?auto=format&fit=crop&w=600&q=80'
];

// Extract image directly from RSS XML payload
function getFeedImage(item, index) {
  if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) return item.mediaContent.$.url;
  if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) return item.mediaThumbnail.$.url;
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  
  const htmlContent = item.content || item['content:encoded'] || item.summary || item.description || '';
  const imgMatch = htmlContent.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch && imgMatch[1]) return imgMatch[1];

  return FALLBACK_IMAGES[index % FALLBACK_IMAGES.length];
}

// Extract Author or Fall Back to Domain Parsing
function getCardSource(item, feedTitle, articleLink) {
  let rawAuthor = item.dcCreator || item.author || item.creator;
  if (rawAuthor) {
    if (typeof rawAuthor === 'object' && rawAuthor.name) rawAuthor = rawAuthor.name;
    if (typeof rawAuthor === 'string') {
      let cleanAuthor = rawAuthor
        .replace(/<[^>]*>/g, '')
        .replace(/[\w.-]+@[\w.-]+\.\w+/g, '')
        .replace(/[()]/g, '')
        .replace(/^by\s+/i, '')
        .trim();
      if (cleanAuthor.length > 0 && cleanAuthor.toLowerCase() !== 'admin') {
        return cleanAuthor.toUpperCase();
      }
    }
  }

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

    return brandMap[brand.toLowerCase()] || brand.toUpperCase();
  } catch (e) {
    return feedTitle ? feedTitle.replace(/RSS|Feed|News|Latest/gi, '').trim().toUpperCase() : 'INTELLIGENCE';
  }
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

    // Sort by publication date (newest first)
    allArticles.sort((a, b) => b.rawDate - a.rawDate);

    res.json(allArticles);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));