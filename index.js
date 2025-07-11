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

app.get('/scrape-mmt-offers', async (req, res) => {
  const baseUrl = 'https://www.makemytrip.com/offers/';
  const scraperApiUrl = `https://api.scraperapi.com/?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(baseUrl)}&render=true`;

  try {
    const response = await axios.get(scraperApiUrl, { timeout: 20000 });
    const $ = cheerio.load(response.data);
    const offers = [];

    $('.common-offers-card .font26').each((i, el) => {
      const title = $(el).text().trim();
      const description = $(el).parent().find('.font14').text().trim();
      if (title.toLowerCase().includes('flight')) {
        offers.push({ title, description });
      }
    });

    res.json({ offers });
  } catch (error) {
    console.error('Scraping error:', error.message);
    res.status(500).json({ error: 'Scraping failed', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
