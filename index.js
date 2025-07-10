import express from 'express';
import cors from 'cors';
import axios from 'axios';
import cheerio from 'cheerio';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/scrape-mmt-offers', async (req, res) => {
  try {
    const url = 'https://www.makemytrip.com/offers/';
    const fullUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(url)}`;
    const response = await axios.get(fullUrl);
    const html = response.data;
    const $ = cheerio.load(html);

    const offers = [];

    $('.offer-block').each((i, el) => {
      const text = $(el).text();
      if (text.toLowerCase().includes('flight')) {
        offers.push(text.trim());
      }
    });

    res.json({ offers });
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: 'Failed to scrape offers' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Scraper running on port ${PORT}`);
});
