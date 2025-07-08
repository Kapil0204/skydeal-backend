const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

// ---- Kiwi API Flight Search ----
app.get('/kiwi', async (req, res) => {
  const { origin, destination, date, adults = 1, travelClass = "ECONOMY" } = req.query;

  try {
    const response = await axios.get('https://kiwi-flight-search.p.rapidapi.com/flights', {
      params: {
        fly_from: origin,
        fly_to: destination,
        date_from: date,
        date_to: date,
        adults,
        selected_cabins: travelClass === "BUSINESS" ? "C" : "M",
        curr: "INR"
      },
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-flight-search.p.rapidapi.com'
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error("Kiwi API error:", error.message);
    res.status(500).json({ error: "Failed to fetch flights from Kiwi" });
  }
});

// ---- ScraperAPI + Cheerio to Fetch MMT Offers ----
app.get('/offers', async (req, res) => {
  try {
    const targetURL = 'https://www.makemytrip.com/promos/flight-offers.html';
    const fullURL = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(targetURL)}`;

    const { data } = await axios.get(fullURL);
    const $ = cheerio.load(data);
    const offers = [];

    $('.promo-card').each((i, el) => {
      const title = $(el).find('h2, h3, .promo-title').first().text().trim();
      const description = $(el).text().trim();
      const isFlightRelated = /flight|fly|air|fare|aviation|airfare/i.test(title + description);
      if (isFlightRelated) {
        offers.push({ title, description });
      }
    });

    res.json(offers);
  } catch (err) {
    res.status(500).json({ error: 'Offer scraping failed', details: err.message });
  }
});

// ---- Health Check ----
app.get('/', (req, res) => {
  res.send('SkyDeal backend is running');
});

// ---- Start Server ----
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
