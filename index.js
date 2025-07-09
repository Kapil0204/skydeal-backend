import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/kiwi', async (req, res) => {
  const { origin, destination, date, returnDate, adults, travelClass } = req.query;

  const url = `https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip?source=City:${origin}&destination=City:${destination}&currency=INR&locale=en&adults=${adults || 1}&children=0&infants=0&bags=1&cabinClass=${travelClass || 'ECONOMY'}&sortBy=QUALITY&sortOrder=ASCENDING&limit=10&returnDateFrom=${returnDate || ''}&returnDateTo=${returnDate || ''}&dateFrom=${date}&dateTo=${date}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || 'Kiwi API Error' });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`SkyDeal backend running on port ${PORT}`);
});
