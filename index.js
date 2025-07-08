const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ✅ Kiwi API Flight Search
app.get('/kiwi', async (req, res) => {
  const { origin, destination, date, adults = 1, travelClass = "ECONOMY" } = req.query;

  try {
    const response = await axios.get('https://kiwi-com.p.rapidapi.com/v2/search', {
      params: {
        fly_from: origin,
        fly_to: destination,
        date_from: date,
        date_to: date,
        adults,
        selected_cabins: travelClass,
        curr: 'INR',
        sort: 'price',
        limit: 10
      },
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com.p.rapidapi.com'
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error("KIWI API ERROR:", error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch flights from Kiwi' });
  }
});

// ✅ Optional basic root route
app.get('/', (req, res) => {
  res.send('SkyDeal backend is running!');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

