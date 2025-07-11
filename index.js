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
  try {
    const baseUrl = 'https://www.makemytrip.com/offer/domestic-flight-deals.html';
const scraperApiUrl = `https://api.scraperapi.com/?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(baseUrl)}`;



    const response = await axios.get(scraperApiUrl, { timeout: 20000 });
    const html = response.data;
    const $ = cheerio.load(html);

    const offers = [];

    $('.offer-card').each((i, el) => {
      const title = $(el).find('.offer-title').text().trim();
      const description = $(el).find('.offer-desc').text().trim();
      const codeMatch = description.match(/Use code\s+([A-Z0-9]+)/i);
      const code = codeMatch ? codeMatch[1] : null;

      offers.push({ title, description, code });
    });

    res.json({ offers });
  } catch (error) {
    console.error('Scraping failed:', error.message);
    res.status(500).json({ error: 'Scraping failed', details: error.message });
  }
});



app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
