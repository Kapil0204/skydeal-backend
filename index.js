const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// API route
app.get('/kiwi', async (req, res) => {
  const { origin, destination, date, adults, travelClass } = req.query;

  const options = {
    method: 'GET',
    url: 'https://kiwi-com-cheap-flights.p.rapidapi.com/v2/search',
    params: {
      fly_from: origin,
      fly_to: destination,
      date_from: date,
      date_to: date,
      curr: 'INR',
      adults,
      selected_cabins: travelClass.toLowerCase()
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
    console.error('❌ Error fetching flights:', error.message);
    res.status(500).json({ error: 'Failed to fetch from Kiwi API', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

