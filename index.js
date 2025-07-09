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

    console.log('Fetching from URL:', url);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('API Error response:', errorText);
      return res.status(response.status).json({ error: 'Failed to fetch from Kiwi API', details: errorText });
    }

    const data = await response.json();

    // Log the result to make sure it's a plain object
    console.log('API data:', data);

    res.json(data); // ✅ This is safe now
  } catch (error) {
    console.error('Error in /kiwi handler:', error.message);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});








