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

// ----------------------
// Simulated Flight Data
// ----------------------
app.post('/simulated-flights', (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass, paymentMethods, tripType } = req.body;

  const bestDeals = {
    'ICICI Bank': { portal: 'MakeMyTrip', offer: '10% off', code: 'SKYICICI10', price: 4900 },
    'HDFC Bank': { portal: 'Goibibo', offer: '12% off', code: 'SKYHDFC12', price: 5100 },
    'SBI Card': { portal: 'EaseMyTrip', offer: '15% off', code: 'SKYSBI15', price: 4800 },
    'Axis Bank': { portal: 'Cleartrip', offer: '5% off', code: 'SKYAXIS5', price: 5200 },
    'AU Bank': { portal: 'Ixigo', offer: '20% off', code: 'SKYAU20', price: 4500 },
  };

  const simulatedFlights = [
    {
      airline: 'IndiGo',
      departure: '06:45',
      arrival: '08:30',
      price: 5600,
      paymentDeals: bestDeals
    },
    {
      airline: 'SpiceJet',
      departure: '09:00',
      arrival: '10:45',
      price: 5300,
      paymentDeals: bestDeals
    },
    {
      airline: 'Air India Express',
      departure: '14:00',
      arrival: '15:50',
      price: 5700,
      paymentDeals: bestDeals
    }
  ];

  const returnFlights = [
    {
      airline: 'IndiGo',
      departure: '18:15',
      arrival: '20:00',
      price: 5800,
      paymentDeals: bestDeals
    },
    {
      airline: 'SpiceJet',
      departure: '21:00',
      arrival: '22:45',
      price: 5500,
      paymentDeals: bestDeals
    }
  ];

  res.json({
    outbound: simulatedFlights,
    return: tripType === 'round-trip' ? returnFlights : []
  });
});

// ----------------------
// Scrape MMT Offers Page (no timeout)
// ----------------------
app.get('/scrape-mmt-offers', async (req, res) => {
  try {
    const baseUrl = 'https://www.makemytrip.com/offer/domestic-flight-deals.html?render=true';
    const scraperApiUrl = `https://api.scraperapi.com/?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(baseUrl)}&render=true`;

    const response = await axios.get(scraperApiUrl); // ⛔ No timeout set
    const html = response.data;
    const $ = cheerio.load(html);

    const offers = [];

    $('.offer-card').each((i, el) => {
      const title = $(el).find('.offer-title').text().trim();
      const description = $(el).find('.offer-desc').text().trim();
      const codeMatch = description.match(/Use code:\s*([A-Z0-9]+)/i);
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
