const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

app.get('/kiwi', async (req, res) => {
  const { origin, destination, date } = req.query;

  const url = 'https://kiwi-com-cheap-flights.p.rapidapi.com/v1/flights';

  const params = {
    fly_from: origin,
    fly_to: destination,
    date_from: date,
    date_to: date,
    curr: 'INR',
    limit: 10
  };

  const headers = {
    'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
    'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
  };

  try {
    const response = await axios.get(url, { params, headers });
    const data = response.data.data.map(flight => ({
      airline: flight.airlines[0] || 'Unknown',
      departureTime: flight.dTimeUTC ? new Date(flight.dTimeUTC * 1000).toISOString() : null,
      arrivalTime: flight.aTimeUTC ? new Date(flight.aTimeUTC * 1000).toISOString() : null,
      price: flight.price || 'N/A'
    }));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch from Kiwi API', details: error?.response?.data || error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
