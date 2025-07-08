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
app.get('/kiwi', async (req, res) => {
  const { origin, destination, date, returnDate, adults = 1, travelClass = "M" } = req.query;

  try {
    const options = {
      method: 'GET',
      url: 'https://kiwi-com.p.rapidapi.com/v2/search',
      params: {
        fly_from: origin,
        fly_to: destination,
        date_from: date,
        date_to: date,
        return_from: returnDate || '',
        return_to: returnDate || '',
        adults,
        selected_cabins: travelClass,
        curr: 'INR',
        limit: 10
      },
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com.p.rapidapi.com'
      }
    };

    const response = await axios.request(options);
    res.json(response.data);
  } catch (error) {
    console.error('Kiwi API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch flight data from Kiwi' });
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


