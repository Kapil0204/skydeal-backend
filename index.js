import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
  origin: 'https://skydeal-frontend-o0iiadcon-kapils-projects-0b446913.vercel.app',
}));

app.get('/kiwi', async (req, res) => {
  try {
    const {
      flyFrom,
      to,
      dateFrom,
      dateTo,
      oneWay,
      adults,
      travelClass,
    } = req.query;

    const url = `https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip?fly_from=${flyFrom}&fly_to=${to}&date_from=${dateFrom}&date_to=${dateTo}&curr=INR&adults=${adults}&selected_cabins=${travelClass}&one_for_city=1&max_stopovers=2`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com',
      },
    });

    if (!response.ok) throw new Error(`Kiwi API error: ${response.status}`);

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});




