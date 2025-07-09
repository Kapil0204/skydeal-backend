import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;

app.get('/kiwi', async (req, res) => {
  try {
    const {
      fly_from,
      fly_to,
      date_from,
      date_to,
      adults,
      selectedCabinClass
    } = req.query;

    const searchParams = new URLSearchParams({
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
      limit: '20'
    });

    const response = await fetch(`https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip?${searchParams.toString()}`, {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
      }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'API Error');
    }

    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

