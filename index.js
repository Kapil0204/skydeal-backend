// index.js (for backend)
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Skydeal backend live');
});

// Route to handle Kiwi API flight search
app.get('/kiwi', async (req, res) => {
  const {
    flyFrom,
    to,
    dateFrom,
    dateTo,
    returnFrom,
    returnTo,
    oneWay,
    flight_type = 'round',
    adults = 1,
    selectedCabin = 'M',
    currency = 'INR',
  } = req.query;

  try {
    const response = await axios.get('https://kiwi.com/api/v2/search', {
      headers: {
        'apikey': process.env.RAPIDAPI_KEY, // stored in .env
      },
      params: {
        fly_from: flyFrom,
        fly_to: to,
        date_from: dateFrom,
        date_to: dateTo,
        return_from: returnFrom,
        return_to: returnTo,
        flight_type,
        one_for_city: 1,
        one_per_date: 0,
        adults,
        selected_cabins: selectedCabin,
        curr: currency,
        max_stopovers: 1,
      },
    });

    res.json(response.data);
  } catch (error) {
    console.error('KIWI API ERROR:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
