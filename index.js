import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { load } from 'cheerio';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.post('/scrape-offers', async (req, res) => {
  try {
    const { data: html } = await axios.get('https://www.makemytrip.com/offers/');
    const $ = load(html);

    const offers = [];

    $('.offer-card').each((_, element) => {
      const title = $(element).find('.offer-title').text().trim();
      const description = $(element).find('.offer-desc').text().trim();
      const code = $(element).find('.offer-code').text().trim();
      const visibleText = $(element).text();

      // Only push if it's flight-related
      if (/flight|fly/i.test(visibleText)) {
        offers.push({ title, description, code });
      }
    });

    res.json({ offers });
  } catch (err) {
    console.error('Scraping failed:', err.message);
    res.status(500).json({ error: 'Scraping failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});