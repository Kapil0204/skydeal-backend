import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;

app.get('/kiwi', async (req, res) => {
  const url = 'https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip';

  const headers = {
    'x-rapidapi-host': 'kiwi-com-cheap-flights.p.rapidapi.com',
    'x-rapidapi-key': 'YOUR_RAPIDAPI_KEY' // replace with your key
  };

  const params = new URLSearchParams({
    source: 'City:mumbai_in',
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
    limit: '10',
    inboundDepartureDateStart: '2025-07-22T00:00:00',
    inboundDepartureDateEnd: '2025-07-29T00:00:00',
  });

  try {
    const response = await axios.get(url, { headers, params });
    res.json(response.data);
  } catch (error) {
    console.error('❌ Kiwi API error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});



