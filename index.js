const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

const API_KEY = process.env.RAPIDAPI_KEY;

app.get('/kiwi', async (req, res) => {
  const { origin, destination, date, returnDate, adults = 1, travelClass = 'ECONOMY' } = req.query;

  const options = {
    method: 'GET',
    url: 'https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip',
    params: {
      sourceCountry: 'IN',
      sourceCity: origin,
      destinationCity: destination,
      currency: 'INR',
      adults,
      children: 0,
      infants: 0,
      bags: 0,
      cabinClass: travelClass,
      mixedClasses: false,
      returnDate: returnDate || '',
      sortBy: 'QUALITY',
      transportTypes: 'FLIGHT',
      limit: '10'
    },
    headers: {
      'X-RapidAPI-Key': API_KEY,
      'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
    }
  };

  try {
    const response = await axios.request(options);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching from Kiwi API:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch from Kiwi API', details: error?.response?.data });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
