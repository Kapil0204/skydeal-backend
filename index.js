const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

// Root route
app.get('/', (req, res) => {
  res.send('SkyDeal backend is running');
});

// Kiwi flight search route
app.get('/kiwi', async (req, res) => {
  const { origin, destination, date } = req.query;

  if (!origin || !destination || !date) {
    return res.status(400).json({ error: 'Missing required query parameters: origin, destination, date' });
  }

  try {
    const options = {
      method: 'GET',
      url: 'https://kiwi-com-cheap-flights.p.rapidapi.com/v1/flightSearch',
      params: {
        from: origin,
        to: destination,
        date: date
      },
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
      }
    };

    const response = await axios.request(options);
    res.json(response.data);

  } catch (error) {
    console.error('Kiwi API fetch failed:', error.message);

    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch from Kiwi API',
      details: error.response?.data || error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


