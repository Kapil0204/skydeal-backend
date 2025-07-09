import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('SkyDeal backend is live!');
});

// ✅ FLIGHT ROUTE USING RAPIDAPI + KIWI.COM (Round-trip)
app.get('/kiwi', async (req, res) => {
  try {
    const params = {
      source: 'Country:IN',
      destination: 'City:new-delhi_in',
      currency: 'INR',
      locale: 'en',
      adults: '1',
      children: '0',
      infants: '0',
      applyMixedClasses: 'true',
      allowChangeInboundSource: 'true',
      allowChangeInboundDestination: 'true',
      allowReturnFromDifferentCity: 'true',
      allowDifferentStationConnection: 'true',
      enableSelfTransfer: 'true',
      allowOvernightStopover: 'true',
      outbound: 'MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY,SATURDAY,SUNDAY',
      transportTypes: 'FLIGHT',
      contentProviders: 'FLIXBUS,DIRECTS,FRESH,KAYAK,KIWI',
      limit: '20',
    };

    const url = 'https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip';

    // ✅ convert plain object to URLSearchParams
    const searchParams = new URLSearchParams();
    for (const key in params) {
      searchParams.append(key, params[key]);
    }

    const response = await fetch(`${url}?${searchParams.toString()}`, {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com',
      },
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching from Kiwi API:', error);
    res.status(500).json({ error: 'Failed to fetch flights from Kiwi API.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
