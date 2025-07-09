const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

app.get('/kiwi', async (req, res) => {
  const { origin, destination, date } = req.query;

  const options = {
    method: 'GET',
    url: 'https://kiwi-com-cheap-flights.p.rapidapi.com/v1/oneWay',
    params: {
      from: origin,
      to: destination,
      dateFrom: date,
      dateTo: date,
      currency: 'INR',
      adults: '1'
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
    console.error('Kiwi API fetch failed:', error.message);
    res.status(500).json({ error: 'Failed to fetch from Kiwi API', details: error.message });
  }
});

app.get('/', (req, res) => {
  res.send('SkyDeal backend is running.');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

