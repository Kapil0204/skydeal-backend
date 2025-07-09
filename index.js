const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(cors());

app.get('/kiwi', async (req, res) => {
  try {
    const {
      flyFrom,
      to,
      dateFrom,
      dateTo,
      oneWay,
      adults,
      travelClass
    } = req.query;

    const url = `https://kiwi-com-cheap-flights.p.rapidapi.com/v2/search?fly_from=${flyFrom}&fly_to=${to}&date_from=${dateFrom}&date_to=${dateTo}&adults=${adults}&selected_cabins=${travelClass}&one_for_city=0&one_per_date=0&curr=INR`;

    const options = {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
      }
    };

    const response = await fetch(url, options);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching flight data:', error);
    res.status(500).json({ error: 'Failed to fetch flight data' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

