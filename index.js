import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ----------------------
// MMT Flight Offer Scraper
// ----------------------
app.get('/scrape-mmt-offers', async (req, res) => {
  try {
    const url = 'https://www.makemytrip.com/offers/';
    const response = await axios.get(`http://api.scraperapi.com`, {
      params: {
        api_key: process.env.SCRAPERAPI_KEY,
        url: url,
        render: true
      },
      timeout: 20000 // 20 seconds
    });

    const html = response.data;
    console.log("Scraped HTML length:", html.length);

    const $ = cheerio.load(html);
    const offerCards = $('.makeFlex.column');

    console.log("Found offer card count:", offerCards.length);

    const offers = [];

    offerCards.each((i, el) => {
      const text = $(el).text().trim();
      if (/flight|fly|air/i.test(text)) {
        console.log("Flight offer found:", text);
        offers.push({ text });
      }
    });

    res.json({ offers });
  } catch (error) {
    console.error('Scraping error:', error.message);
    res.status(500).json({ error: 'Scraping failed', details: error.message });
  }
});

// ----------------------
// Start Server
// ----------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
