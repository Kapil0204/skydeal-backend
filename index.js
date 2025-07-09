import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ CORS MUST BE SET BEFORE ROUTES
app.use(cors({
  origin: '*', // or specify Vercel frontend URL here for tighter security
}));

app.get('/kiwi', async (req, res) => {
  const { flyFrom, to, dateFrom, dateTo, adults, travelClass, oneWay } = req.query;

  const url = `https://kiwi-com-cheap-flights.p.rapidapi.com/roundTrip?flyFrom=${flyFrom}&to=${to}&dateFrom=${dateFrom}&dateTo=${dateTo}&adults=${adults}&travelClass=${travelClass}&oneWay=${oneWay}&curr=INR`;

  const options = {
    method: 'GET',
    headers: {
      'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
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
  console.log(`Server running on port ${PORT}`);
});

