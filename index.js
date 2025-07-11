import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

app.get('/scrape-mmt-offers', async (req, res) => {
  try {
    const targetUrl = 'https://www.makemytrip.com/offers/';
    const apiUrl = `http://api.scraperapi.com/?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}`;

    const { data: html } = await axios.get(apiUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        Accept: 'text/html',
      },
    });

    const $ = cheerio.load(html);
    const offers = [];

    $('.offer-card').each((i, el) => {
      const text = $(el).text().trim();
      const isFlightOffer = /flight|air/i.test(text);
      if (isFlightOffer) {
        offers.push({ text });
      }
    });

    res.json({ offers });
  } catch (error) {
    console.error('Error scraping MMT:', error.message);
    res.status(500).json({ error: 'Scraping failed', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
