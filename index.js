const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

app.get('/kiwi', async (req, res) => {
  const { origin, destination, date, returnDate, adults, travelClass } = req.query;

  const url = returnDate
    ? `https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip?sourceCountry=IN&origin=${origin}&destination=${destination}&dateFrom=${date}&returnFrom=${returnDate}&adults=${adults}&cabinClass=${travelClass}&currency=INR&locale=en&limit=20`
    : `https://kiwi-com-cheap-flights.p.rapidapi.com/one-way?sourceCountry=IN&origin=${origin}&destination=${destination}&dateFrom=${date}&adults=${adults}&cabinClass=${travelClass}&currency=INR&locale=en&limit=20`;

  const options = {
    method: 'GET',
    headers: {
      'X-RapidAPI-Key': 'c20c8406fdmsh6b8b35e214af438p1c3ab4jsn15ca574a21c5',
      'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com',
    },
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Failed to fetch flights');
    }

    res.json(data);
  } catch (error) {
    console.error('Error fetching flights:', error.message);
    res.status(500).json({
      error: 'Failed to fetch from Kiwi API',
      details: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});






