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

// ===============================
// Route: Scrape MMT Offers
// ===============================
app.get('/scrape-mmt-offers', async (req, res) => {
  try {
    const response = await axios.get('https://www.makemytrip.com/offers/', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
      },
      timeout: 10000,
    });

    const html = response.data;
    const $ = cheerio.load(html);

    const offers = [];

    $('.offer-content').each((i, el) => {
      const title = $(el).find('.title').text().trim();
      const desc = $(el).find('.desc').text().trim();
      const code = $(el).find('.coupon-code span').text().trim();

      const bankMatch = title.match(/ICICI|HDFC|SBI|Axis|RBL|BOB|Federal|Yes|Bank/i);
      const bank = bankMatch ? bankMatch[0] : 'General';

      if (/flight|fly/i.test(title + desc)) {
        offers.push({ title, desc, code, bank });
      }
    });

    res.json({ offers });
  } catch (error) {
    res.status(500).json({
      error: 'Scraping failed',
      details: error.message,
    });
  }
});

// =========================
// Start Server
// =========================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
