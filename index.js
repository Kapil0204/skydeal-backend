import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

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
      limit: 20
    };

    const url = new URL('https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip');
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

    const response = await fetch(url.href, {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
      }
    });

    const data = await response.json();

    if (response.ok) {
      res.json(data);
    } else {
      res.status(response.status).json({ error: data.message || 'Unknown error' });
    }

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});





