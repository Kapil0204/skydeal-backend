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
    const baseUrl = 'https://www.makemytrip.com/offer/domestic-flight-deals.html';
    const scraperApiUrl = `https://api.scraperapi.com/?api_key=${process.env.SCRAPERAPI_KEY}&render=true&url=${encodeURIComponent(baseUrl)}`;

    const response = await axios.get(scraperApiUrl);
    const html = response.data;
    const $ = cheerio.load(html);

    const offers = [];

    $('.offer-card').each((i, el) => {
      const title = $(el).find('.offer-title').text().trim();
      const description = $(el).find('.offer-desc').text().trim();
      const codeMatch = description.match(/Use code:?\s*([A-Z0-9]+)/i);
      const code = codeMatch ? codeMatch[1] : null;

      const isFlightOffer = /flight|fly/i.test(title + description);
      if (isFlightOffer) {
        offers.push({ title, description, code });
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
