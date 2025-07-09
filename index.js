const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

app.get('/kiwi', async (req, res) => {
  const { origin, destination, date, tripType } = req.query;

  const url = tripType === 'round'
    ? 'https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip'
    : 'https://kiwi-com-cheap-flights.p.rapidapi.com/one-way';

  const options = {
    method: 'GET',
    url,
    params: {
      sourceCountry: 'IN',
      sourceDestination: origin,
      destinationCountry: 'IN',
      destinationCity: destination,
      adults: '1',
      cabinClass: 'ECONOMY',
      currency: 'INR',
      locale: 'en',
      limit: '5',
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
    console.error('Error fetching flights:', error.message);
    res.status(500).json({ error: 'Failed to fetch from Kiwi API', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});




