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

// ----------------------
// Simulated Flight Data
// ----------------------
app.post('/simulated-flights', (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass, paymentMethods, tripType } = req.body;

  const bestDeals = {
    'ICICI Bank': { portal: 'MakeMyTrip', offer: '10% off', code: 'SKYICICI10', price: 4900 },
    'HDFC Bank': { portal: 'Goibibo', offer: '12% off', code: 'SKYHDFC12', price: 4700 },
    'Axis Bank': { portal: 'EaseMyTrip', offer: '15% off', code: 'SKYAXIS15', price: 4500 }
  };

  const outboundFlights = [
    {
      flightName: 'IndiGo 6E123',
      departure: '08:00',
      arrival: '10:00',
      bestDeal: bestDeals[paymentMethods[0]] || null
    },
    {
      flightName: 'Air India AI456',
      departure: '12:30',
      arrival: '14:45',
      bestDeal: bestDeals[paymentMethods[0]] || null
    }
  ];

  const returnFlights = tripType === 'round-trip' ? [
    {
      flightName: 'SpiceJet SG789',
      departure: '18:00',
      arrival: '20:00',
      bestDeal: bestDeals[paymentMethods[0]] || null
    },
    {
      flightName: 'Vistara UK321',
      departure: '21:30',
      arrival: '23:50',
      bestDeal: bestDeals[paymentMethods[0]] || null
    }
  ] : [];

  res.json({ outboundFlights, returnFlights });
});

// ----------------------
// Kiwi.com Real Flights
// ----------------------
app.post('/kiwi', async (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass } = req.body;

  const options = {
    method: 'GET',
    url: 'https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip',
    params: {
      from,
      to,
      dateFrom: departureDate,
      dateTo: departureDate,
      returnFrom: returnDate || '',
      returnTo: returnDate || '',
      adults: passengers,
      selectedCabins: travelClass.toLowerCase(),
      currency: 'INR'
    },
    headers: {
      'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
    }
  };

  try {
    const response = await axios.request(options);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Kiwi flights:', error.message);
    res.status(500).json({ error: 'Failed to fetch real flights' });
  }
});

// ----------------------
// Scrape MMT ICICI Page
// ----------------------
app.get('/scrape-mmt-offers', async (req, res) => {
  const targetUrl = "https://www.makemytrip.com/promos/df-icici-02012023.html";
  const apiUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}`;

  try {
    const response = await axios.get(apiUrl);
    const $ = cheerio.load(response.data);
    const offers = [];

    $('div').each((i, el) => {
      const text = $(el).text().trim();
      if (text && /(flight|fly|discount|code|ICICI|save|Rs|\boff\b)/i.test(text)) {
        offers.push({ text });
      }
    });

    res.json({ offers });
  } catch (error) {
    console.error("Error scraping MMT:", error.message);
    res.status(500).json({ error: 'Scraping failed' });
  }
});
// ------------------------------
// Scrape All MMT Promo Page Links (Improved Fallback)
// ------------------------------
app.get('/scrape-mmt-links', async (req, res) => {
  const targetUrl = "https://www.makemytrip.com/offers/";
  const apiUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}&render=true`;

  try {
    const response = await axios.get(apiUrl);
    const $ = cheerio.load(response.data);
    const promoUrls = new Set();

    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (href && href.startsWith('/promos/df-') && href.endsWith('.html')) {
        promoUrls.add('https://www.makemytrip.com' + href);
      }
    });

    res.json({ promoUrls: [...promoUrls] });
  } catch (error) {
    console.error("Error scraping MMT links:", error.message);
    res.status(500).json({ error: 'Scraping links failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
