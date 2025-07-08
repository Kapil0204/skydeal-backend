const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

// ---- Amadeus Flight Search ----
// ----- Amadeus Flight Search (Supports Return Flights) -----
app.get('/amadeus', async (req, res) => {
  const {
    origin,
    destination,
    date: departureDate,
    returnDate,
    adults = 1,
    travelClass = 'ECONOMY',
    currencyCode = 'INR',
    max = 10
  } = req.query;

  try {
    // Step 1: Get access token
    const tokenResponse = await axios.post(
      'https://test.api.amadeus.com/v1/security/oauth2/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.AMADEUS_CLIENT_ID,
        client_secret: process.env.AMADEUS_CLIENT_SECRET
      })
    );

    const accessToken = tokenResponse.data.access_token;

    // Step 2: Prepare search parameters
    const searchParams = {
      originLocationCode: origin,
      destinationLocationCode: destination,
      departureDate,
      adults,
      travelClass,
      currencyCode,
      max
    };

    if (returnDate) {
      searchParams.returnDate = returnDate;
    }

    // Step 3: Call Amadeus API
    const flightResponse = await axios.get(
      'https://test.api.amadeus.com/v2/shopping/flight-offers',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        params: searchParams
      }
    );

    res.json(flightResponse.data);
  } catch (error) {
    console.error('Amadeus API error:', error.message || error);
    res.status(500).json({ error: 'Failed to fetch flight data from Amadeus' });
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

app.get('/', (req, res) => {
  res.send('SkyDeal backend is running');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
