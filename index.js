import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';

dotenv.config(); // Load environment variables

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------------------------
// Scrape MMT Flight Offers
// ---------------------------
app.get('/scrape-mmt-offers', async (req, res) => {
  try {
    const url = 'https://www.makemytrip.com/offer/';
    const response = await axios.get('http://api.scraperapi.com', {
      params: {
        api_key: process.env.SCRAPER_API_KEY,
        url: url
      }
    });

    const html = response.data;
    console.log('--- RAW HTML START ---\n' + html.slice(0, 1000) + '\n--- RAW HTML END ---');

    const $ = cheerio.load(html);
    const offers = [];

    $('div, li, span, p').each((i, el) => {
      const text = $(el).text().trim();
      const isFlight = /flight|fly|air/i.test(text);
      if (isFlight && text.length > 40) {
        offers.push({ text });
      }
    });

    res.json({ offers });
  } catch (error) {
    console.error('Error scraping MMT:', error.message);
    res.status(500).json({ error: 'Scraping failed', details: error.message });
  }
});



// ---------------------------
// Server Start
// ---------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
