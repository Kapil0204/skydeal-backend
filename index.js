const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

// ✅ Kiwi API Flight Search
app.get('/kiwi', async (req, res) => {
  const { origin, destination, date, adults = 1, travelClass = "M" } = req.query;

  try {
    const response = await axios.get('https://kiwi-com-cheap-flights.p.rapidapi.com/v2/search', {
      params: {
        fly_from: origin,
        fly_to: destination,
        date_from: date,
        date_to: date,
        adults: adults,
        selected_cabins: travelClass,
        curr: 'INR'
      },
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('KIWI API ERROR:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch flights from Kiwi' });
  }
});

// ✅ Scrape MMT Offers (optional)
app.get('/offers', async (req, res) => {
  try {
    const targetURL = 'https://www.makemytrip.com/promos/flight-offers.html';

    const response = await axios.get(targetURL);
    const $ = cheerio.load(response.data);

    const offers = [];
    $('.offer-listing').each((i, el) => {
      const title = $(el).find('.offer-title').text().trim();
      const desc = $(el).find('.offer-desc').text().trim();
      const link = $(el).find('a').attr('href') || '';

      const combined = `${title} ${desc}`.toLowerCase();
      if (
        combined.includes('flight') ||
        combined.includes('fly') ||
        combined.includes('air') ||
        combined.includes('airfare')
      ) {
        offers.push({ title, desc, link });
      }
    });

    res.json({ offers });
  } catch (err) {
    console.error("Error scraping MMT offers:", err.message);
    res.status(500).json({ error: "Failed to scrape offers." });
  }
});

// ✅ Root route
app.get('/', (req, res) => {
  res.send('Skydeal Backend is running.');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
