const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;

// ✅ Use your actual RapidAPI Key from the screenshot
const RAPIDAPI_KEY = 'c20c8406fdmsh6b8b35e214af438p1c3ab4jsn15ca574a21c5';

// ✅ Set the correct endpoint
const API_URL = 'https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip';

app.get('/kiwi', async (req, res) => {
  const { origin, destination, date } = req.query;

  if (!origin || !destination || !date) {
    return res.status(400).json({ error: 'Missing required query parameters.' });
  }

  try {
    const response = await axios.get(API_URL, {
      params: {
        source: origin,
        destination: destination,
        date_from: date,
        date_to: date,
        currency: 'INR',
        locale: 'en',
        adults: 1,
        children: 0,
        infants: 0,
        bags: 0,
        cabinClass: 'ECONOMY',
        limit: 20,
      },
      headers: {
        'X-RapidAPI-Key': RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching from Kiwi API:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch from Kiwi API',
      details: error.response?.data || error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});


