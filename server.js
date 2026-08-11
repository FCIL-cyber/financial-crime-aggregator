const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');

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

// Example working feeds
const FEED_URLS = [
  'https://www.cnbc.com/id/10000115/device/rss/rss.html',
  'https://www.finextra.com/rss/topic/crime'
];

// Helper function to extract image URL from various RSS formats
function getImageUrl(item) {
  if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) {
    return item.mediaContent.$.url;
  }
  if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) {
    return item.mediaThumbnail.$.url;
  }
  if (item.enclosure && item.enclosure.url) {
    return item.enclosure.url;
  }
  // Try extracting from HTML content body if available
  if (item.content || item['content:encoded']) {
    const html = item.content || item['content:encoded'];
    const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgMatch) return imgMatch[1];
  }
  // Fallback image URL
  return 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=600&q=80';
}

app.get('/api/news', async (req, res) => {
  try {
    const feedPromises = FEED_URLS.map(async (url) => {
      try {
        const feed = await parser.parseURL(url);
        return feed.items.map(item => ({
          title: item.title,
          link: item.link,
          date: item.pubDate 
            ? new Date(item.pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) 
            : 'Recent',
          source: feed.title ? feed.title.split(' ')[0].toUpperCase() : 'INTELLIGENCE',
          image: getImageUrl(item)
        }));
      } catch (err) {
        console.error(`Error fetching ${url}:`, err.message);
        return [];
      }
    });

    const results = await Promise.all(feedPromises);
    const allArticles = results.flat();
    res.json(allArticles.slice(0, 18));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch feeds' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));