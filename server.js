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
      ['enclosure', 'enclosure']
    ]
  }
});

const PORT = process.env.PORT || 3000;
app.use(cors());

const FEED_URLS = [
  'https://www.cnbc.com/id/10000115/device/rss/rss.html',
  'https://www.finextra.com/rss/topic/crime'
];

// Helper to scrape og:image from target URL if RSS lacks an image
async function fetchOgImage(link) {
  try {
    const { data } = await axios.get(link, { 
      timeout: 3000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const $ = cheerio.load(data);
    const ogImg = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
    return ogImg || null;
  } catch (err) {
    return null;
  }
}

function getFeedImage(item) {
  if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) return item.mediaContent.$.url;
  if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) return item.mediaThumbnail.$.url;
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  if (item.content || item['content:encoded']) {
    const html = item.content || item['content:encoded'];
    const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgMatch) return imgMatch[1];
  }
  return null;
}

app.get('/api/news', async (req, res) => {
  try {
    const feedPromises = FEED_URLS.map(async (url) => {
      try {
        const feed = await parser.parseURL(url);
        
        // Process articles and extract/scrape unique images
        const itemPromises = feed.items.slice(0, 10).map(async (item) => {
          let image = getFeedImage(item);
          
          // Scrape webpage meta tag if feed didn't provide direct image
          if (!image && item.link) {
            image = await fetchOgImage(item.link);
          }

          return {
            title: item.title,
            link: item.link,
            date: item.pubDate 
              ? new Date(item.pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) 
              : 'Recent',
            source: feed.title ? feed.title.split(' ')[0].toUpperCase() : 'INTELLIGENCE',
            image: image || 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=600&q=80'
          };
        });

        return await Promise.all(itemPromises);
      } catch (err) {
        console.error(`Error fetching ${url}:`, err.message);
        return [];
      }
    });

    const results = await Promise.all(feedPromises);
    const allArticles = results.flat();
    res.json(allArticles);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch feeds' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));