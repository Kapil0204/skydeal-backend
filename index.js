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
    const url = 'https://www.makemytrip.com/offer/domestic-flight-deals.html';

    const response = await axios.get('http://api.scraperapi.com', {
      params: {
        api_key: process.env.SCRAPER_API_KEY,
        url: url,
        render: true
      }
    });

    const $ = cheerio.load(response.data);

    const offers = [];

    $('*').each((i, el) => {
      const text = $(el).text().trim();
      const isFlightOffer = /flight|airfare|domestic/i.test(text);

      if (isFlightOffer && text.length > 20 && text.length < 500) {
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
