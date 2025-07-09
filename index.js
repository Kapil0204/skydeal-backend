import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*', // Temporarily allow all origins. For security, change this to your Vercel domain.
}));
app.use(express.json());

app.get('/kiwi', async (req, res) => {
  try {
    const { flyFrom, to, dateFrom, dateTo, adults, travelClass, oneWay } = req.query;

    const response = await fetch(`https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip?flyFrom=${flyFrom}&to=${to}&dateFrom=${dateFrom}&dateTo=${dateTo}&adults=${adults}&travelClass=${travelClass}&oneWay=${oneWay}`, {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com',
      },
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
