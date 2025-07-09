import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/kiwi', async (req, res) => {
  const { flyFrom, to, dateFrom, dateTo, adults, travelClass, oneWay } = req.query;

  const url = `https://kiwi-com.p.rapidapi.com/v2/search?fly_from=${flyFrom}&fly_to=${to}&date_from=${dateFrom}&date_to=${dateTo}&adults=${adults}&selected_cabins=${travelClass}&curr=INR&one_way=${oneWay}`;

  const options = {
    method: 'GET',
    headers: {
      'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'kiwi-com.p.rapidapi.com'
    }
  };

  try {
    const response = await fetch(url, options);
    const result = await response.json();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SkyDeal backend running on port ${PORT}`);
});
