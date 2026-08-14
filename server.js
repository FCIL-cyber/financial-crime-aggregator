const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');

const app = express();
const parser = new Parser();

app.use(cors());
app.use(express.json());

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

// Endpoint to fetch and aggregate feeds
app.get('/api/news', async (req, res) => {
  try {
    let allItems = [];

    for (const url of FEED_URLS) {
      try {
        const feed = await parser.parseURL(url);
        const feedTitle = feed.title || '';

        if (feed && feed.items) {
          const mappedItems = feed.items.map(item => ({
            title: item.title || 'Untitled',
            link: item.link || '#',
            pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
            contentSnippet: item.contentSnippet || item.summary || '',
            source: getCardSource(item, feedTitle, item.link || '')
          }));
          allItems.push(...mappedItems);
        }
      } catch (feedErr) {
        console.error(`Failed to fetch feed: ${url}`, feedErr.message);
      }
    }

    // Sort items newest first
    allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    res.json({ success: true, count: allItems.length, items: allItems });
  } catch (error) {
    console.error('Error aggregating news:', error);
    res.status(500).json({ success: false, error: 'Failed to aggregate news feeds' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});