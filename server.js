const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// 🚧 Enable CORS for your deployed frontend
const allowedOrigins = ['https://skydeal-frontend.vercel.app'];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

// 🛫 Flight Search Endpoint (Amadeus)
app.get('/amadeus', async (req, res) => {
  const {
    origin, destination, date: departureDate,
    returnDate, adults = 1, travelClass = 'ECONOMY',
    currencyCode = 'INR', max = 10
  } = req.query;

  try {
    // 1. Get token
    const tokenRes = await axios.post(
      'https://test.api.amadeus.com/v1/security/oauth2/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.AMADEUS_CLIENT_ID,
        client_secret: process.env.AMADEUS_CLIENT_SECRET
      })
    );
    const accessToken = tokenRes.data.access_token;

    // 2. Build search params
    const params = { originLocationCode: origin, destinationLocationCode: destination,
      departureDate, adults, travelClass, currencyCode, max
    };
    if (returnDate) params.returnDate = returnDate;

    // 3. Call Amadeus
    const flightRes = await axios.get(
      'https://test.api.amadeus.com/v2/shopping/flight-offers',
      { headers: { Authorization: `Bearer ${accessToken}` }, params }
    );

    return res.json(flightRes.data);
  } catch (err) {
    console.error('Amadeus API error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch flight data' });
  }
});

// ✈️ Offer Scraper Endpoint
app.get('/offers', async (req, res) => {
  try {
    const targetURL = 'https://www.makemytrip.com/promos/flight-offers.html';
    const fullURL = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(targetURL)}`;
    const { data } = await axios.get(fullURL);
    const $ = cheerio.load(data);
    const offers = [];
    $('.promo-card').each((i, el) => {
      const title = $(el).find('h2, h3, .promo-title').first().text().trim();
      const desc = $(el).text().trim();
      if (/flight|airfare/i.test(title + desc)) {
        offers.push({ title, description: desc });
      }
    });
    res.json(offers);
  } catch (e) {
    console.error('Offer scraping failed:', e.message);
    res.status(500).json({ error: 'Offer scraping failed' });
  }
});

app.get('/', (req, res) => res.send('SkyDeal backend is running'));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));


