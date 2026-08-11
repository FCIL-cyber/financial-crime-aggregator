const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const parser = new Parser({
  timeout: 5000,
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

// List of RSS Feeds
const FEED_URLS = [
  'https://www.cnbc.com/id/100003114/device/rss/rss.html',
  'https://www.finextra.com/rss/topic/crime'
];

// Scrape og:image or twitter:image from article HTML
async function fetchOgImage(link) {
  try {
    const { data } = await axios.get(link, { 
      timeout: 4000,
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }
    });
    const $ = cheerio.load(data);
    const ogImg = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
    return ogImg || null;
  } catch (err) {
    return null;
  }
}

// Extract image directly from RSS XML payload
function getFeedImage(item) {
  if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) return item.mediaContent.$.url;
  if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) return item.mediaThumbnail.$.url;
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  
  const htmlContent = item.content || item['content:encoded'] || item.summary || item.description || '';
  const imgMatch = htmlContent.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch && imgMatch[1]) return imgMatch[1];

  return null;
}

// Extract Author or Fall Back to Domain Parsing
function getCardSource(item, feedTitle, articleLink) {
  // 1. Try explicit author field
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

  // 2. Parse domain name from the article link
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
      'cnbc': 'CNBC'
    };

    return brandMap[brand.toLowerCase()] || brand.toUpperCase();
  } catch (e) {
    // 3. Fallback to feed title
    return feedTitle ? feedTitle.replace(/RSS|Feed|News|Latest/gi, '').trim().toUpperCase() : 'INTELLIGENCE';
  }
}

app.get('/api/news', async (req, res) => {
  try {
    const feedPromises = FEED_URLS.map(async (url) => {
      try {
        const feed = await parser.parseURL(url);
        
        const itemPromises = feed.items.slice(0, 8).map(async (item) => {
          let image = getFeedImage(item);
          
          if (!image && item.link) {
            image = await fetchOgImage(item.link);
          }

          return {
            title: item.title,
            link: item.link,
            date: item.pubDate 
              ? new Date(item.pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) 
              : 'Recent',
            source: getCardSource(item, feed.title, item.link),
            image: image || 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=600&q=80'
          };
        });

        return await Promise.all(itemPromises);
      } catch (err) {
        console.error(`Error fetching feed ${url}:`, err.message);
        return [];
      }
    });

    const results = await Promise.all(feedPromises);
    const allArticles = results.flat();
    res.json(allArticles);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));