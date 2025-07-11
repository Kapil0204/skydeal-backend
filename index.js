import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';

dotenv.config(); // Load .env variables

const app = express();
const PORT = process.env.PORT || 9000;

app.use(cors());
app.use(express.json());

app.get('/scrape-mmt-offers', async (req, res) => {
  try {
    const url = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}&url=https://www.makemytrip.com/offers/&render=true`;

    const response = await axios.get(url, { timeout: 20000 }); // 20 sec timeout

    const $ = cheerio.load(response.data);
    const offers = [];

    $('.offer-content').each((i, el) => {
      const title = $(el).find('.title').text().trim();
      const description = $(el).find('.desc').text().trim();
      const code = $(el).find('.coupon-code').text().trim();
      const bankMatch = title.match(/ICICI|HDFC|SBI|Axis|Kotak|RBL/i);

      offers.push({
        bank: bankMatch ? bankMatch[0] : 'General',
        title,
        description,
        code
      });
    });

    res.json({ offers });
  } catch (error) {
    res.status(500).json({
      error: 'Scraping failed',
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
