const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());

app.get('/kiwi', async (req, res) => {
  try {
    const { origin, destination, date, returnDate, adults = 1, travelClass = 'ECONOMY' } = req.query;

    if (!origin || !destination || !date) {
      return res.status(400).json({ error: 'Missing required query parameters.' });
    }

    const params = {
      fly_from: origin,
      fly_to: destination,
      date_from: date,
      date_to: date,
      return_from: returnDate || undefined,
      return_to: returnDate || undefined,
      flight_type: returnDate ? 'round' : 'oneway',
      adults,
      selected_cabins: travelClass,
      curr: 'INR',
      locale: 'en'
    };

    const response = await axios.get('https://kiwi-com.p.rapidapi.com/api/v1/flights', {
      params,
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com.p.rapidapi.com'
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching flights:', error.message);
    res.status(500).json({ error: 'Failed to fetch from Kiwi API', details: error.response?.data || error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});



