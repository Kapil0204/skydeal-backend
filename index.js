const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
const PORT = process.env.PORT || 10000;

app.get('/kiwi', async (req, res) => {
  const { origin, destination, date, returnDate, adults, travelClass } = req.query;

  const url = 'https://kiwi-com-cheap-flights.p.rapidapi.com/v2/search';

  const params = {
    fly_from: origin,
    fly_to: destination,
    date_from: date,
    date_to: date,
    return_from: returnDate || undefined,
    return_to: returnDate || undefined,
    curr: 'INR',
    adults: adults || 1,
    selected_cabins: travelClass || 'M',
    max_stopovers: 1,
    limit: 10
  };

  try {
    const response = await axios.get(url, {
      params,
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching flights:', error.response?.status, error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch from Kiwi API',
      details: error.response?.data || error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


