const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

// Health check
app.get('/', (req, res) => {
  res.send('SkyDeal backend is running!');
});

// Main flight search route
app.get('/kiwi', async (req, res) => {
  const { origin, destination, date, returnDate, adults, travelClass } = req.query;

  const url = `https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip?origin=${origin}&destination=${destination}&depart_date=${date}&return_date=${returnDate}&adults=${adults}&travel_class=${travelClass}&currency=INR&locale=en`;

  const options = {
    method: 'GET',
    headers: {
      'X-RapidAPI-Key': 'c20c8406fdmsh6b8b35e214af438p1c3ab4jsn15ca574a21c5', // Replace with your key
      'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
    }
  };

  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Kiwi API error: ${response.status} - ${errorData}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching flights:', error.message);
    res.status(500).json({ error: 'Failed to fetch from Kiwi API', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});





