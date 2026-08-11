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

// Working RSS Feeds
const FEED_URLS = [
  'https://www.finextra.com/rss/topic/crime',
  'https://www.cnbc.com/id/100003114/device/rss/rss.html'
];

// Helper: Scrape og:image from target webpage
async function fetchOgImage(link) {
  try {
    const { data } = await axios.get(link, { 
      timeout: 4000,
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const $ = cheerio.load(data);
    return $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || null;
  } catch (err) {
    return null;
  }
}

// Helper: Extract image directly from RSS XML
function getFeedImage(item) {
  if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) return item.mediaContent.$.url;
  if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) return item.mediaThumbnail.$.url;
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  
  const htmlContent = item.content || item['content:encoded'] || item.summary || item.description || '';
  const imgMatch = htmlContent.match(/<img[^>]+src=["']([^"']+)["']/i);
  return imgMatch ? imgMatch[1] : null;
}

// Helper: Extract Author or Domain Name
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
      'cnbc': 'CNBC'
    };

    return brandMap[brand.toLowerCase()] || brand.toUpperCase();
  } catch (e) {
    return feedTitle ? feedTitle.replace(/RSS|Feed|News|Latest/gi, '').trim().toUpperCase() : 'INTELLIGENCE';
  }
}

// Scraper: INTERPOL News & Events
async function scrapeInterpolNews() {
  try {
    const { data } = await axios.get('https://www.interpol.int/News-and-Events', {
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const $ = cheerio.load(data);
    const articles = [];

    // Parse INTERPOL news cards
    $('.news-list__item, .card, article').each((i, el) => {
      const titleEl = $(el).find('h3, .title, .card__title, a');
      const title = titleEl.first().text().trim();
      const relativeLink = $(el).find('a').attr('href');
      const dateStr = $(el).find('.date, time, .card__date').text().trim();
      
      let img = $(el).find('img').attr('src');
      if (img && !img.startsWith('http')) {
        img = `https://www.interpol.int${img}`;
      }

      if (title && relativeLink && title.length > 10) {
        const fullLink = relativeLink.startsWith('http') 
          ? relativeLink 
          : `https://www.interpol.int${relativeLink}`;

        articles.push({
          title: title,
          link: fullLink,
          date: dateStr || 'Recent',
          source: 'INTERPOL',
          image: img || 'https://images.unsplash.com/photo-1589829545856-d10d557cf95f?auto=format&fit=crop&w=600&q=80'
        });
      }
    });

    return articles.slice(0, 6);
  } catch (error) {
    console.error('Error scraping INTERPOL:', error.message);
    return [];
  }
}

app.get('/api/news', async (req, res) => {
  try {
    // 1. Fetch RSS Feeds
    const rssPromises = FEED_URLS.map(async (url) => {
      try {
        const feed = await parser.parseURL(url);
        const itemPromises = feed.items.slice(0, 6).map(async (item) => {
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

    // 2. Fetch Scraped INTERPOL News
    const interpolPromise = scrapeInterpolNews();

    // 3. Resolve all promises simultaneously
    const [rssResults, interpolArticles] = await Promise.all([
      Promise.all(rssPromises),
      interpolPromise
    ]);

    // Flatten into single list
    let allArticles = [...rssResults.flat(), ...interpolArticles];

    res.json(allArticles);
  } catch (error) {
    res.status(500).json({ error: 'Failed to aggregate news' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));