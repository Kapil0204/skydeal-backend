import express from 'express';
import cors from 'cors';
import axios from 'axios';
import cheerio from 'cheerio';
import dotenv from 'dotenv';

dotenv.config(); // ✅ Load environment variables from .env

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ----------------------
// Simulated Flight Data
// ----------------------
app.post('/simulated-flights', (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass, paymentMethods, tripType } = req.body;

  const bestDeals = {
    'ICICI Bank': { portal: 'MakeMyTrip', offer: '10% off', code: 'SKYICICI10', price: 4900 },
    'HDFC Bank': { portal: 'Goibibo', offer: '12% off', code: 'SKYHDFC12', price: 4700 },
    'SBI': { portal: 'Yatra', offer: '8% off', code: 'SKYSBI8', price: 5000 },
    'Axis Bank': { portal: 'EaseMyTrip', offer: '9% off', code: 'SKYAXIS9', price: 4800 },
    'Kotak Bank': { portal: 'Cleartrip', offer: '11% off', code: 'SKYKOTAK11', price: 4600 }
  };

  const generateFlights = () => [
    {
      airline: 'IndiGo',
      departure: '08:30',
      arrival: '10:45',
      bestDeal: bestDeals[paymentMethods[0]] || bestDeals['ICICI Bank']
    },
    {
      airline: 'Air India',
      departure: '09:00',
      arrival: '11:20',
      bestDeal: bestDeals[paymentMethods[1]] || bestDeals['HDFC Bank']
    }
  ];

  const response = {
    outbound: generateFlights(),
    return: tripType === 'roundTrip' ? generateFlights() : null
  };

  res.json(response);
});

// ----------------------
// Scrape MMT Offers
// ----------------------
app.get('/scrape-mmt-offers', async (req, res) => {
  try {
    const url = 'https://www.makemytrip.com/offers/';
    const fullUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(url)}`;

    const response = await axios.get(fullUrl);
    const html = response.data;
    const $ = cheerio.load(html);

    const offers = [];

    $('.offer-block').each((index, el) => {
      const text = $(el).text();
      if (text.toLowerCase().includes('flight')) {
        offers.push(text.trim());
      }
    });

    res.json({ offers });
  } catch (error) {
    console.error('❌ Scraping error:', error.message);
    res.status(500).json({ error: 'Failed to scrape offers' });
  }
});

// ----------------------
// Start Server
// ----------------------
app.listen(PORT, () => {
  console.log(`✅ SkyDeal backend running on port ${PORT}`);
});
