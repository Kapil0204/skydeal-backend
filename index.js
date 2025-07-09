const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

app.get('/kiwi', async (req, res) => {
  try {
    const { flyFrom, to, dateFrom, dateTo, oneWay } = req.query;

    const url = `https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip?sourceAirportCode=${flyFrom}&destinationAirportCode=${to}&dateFrom=${dateFrom}&dateTo=${dateTo}&oneWay=${oneWay}`;

    const options = {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
      }
    };

    const response = await fetch(url, options);
    const data = await response.json(); // ✅ FIX: parse JSON before sending
    res.json(data);
  } catch (error) {
    console.error('Error fetching flights:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});







