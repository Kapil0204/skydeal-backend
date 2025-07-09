const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

app.get('/', (req, res) => {
  res.send('SkyDeal backend is live');
});

app.get('/kiwi', async (req, res) => {
  const { origin, destination, date } = req.query;

  if (!origin || !destination || !date) {
    return res.status(400).json({ error: 'Missing required query parameters' });
  }

  try {
    const response = await axios.get('https://kiwi-com-cheap-flights.p.rapidapi.com/roundtrip', {
      params: {
        from: origin,
        to: destination,
        date: date,
        currency: 'INR',
        locale: 'en'
      },
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Kiwi API fetch failed:', error.response?.status, error.response?.data);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch from Kiwi API',
      details: error.response?.data || error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

