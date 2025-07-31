// ✅ BACKEND: index.js
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ✅ Amadeus Real Flights Endpoint
app.post('/search', async (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body;

  const headers = {
    'Authorization': `Bearer ${process.env.AMADEUS_ACCESS_TOKEN}`
  };

  const params = {
    originLocationCode: from,
    destinationLocationCode: to,
    departureDate,
    adults: passengers,
    travelClass,
    currencyCode: 'INR'
  };

  if (tripType === 'round-trip') {
    params.returnDate = returnDate;
  }

  try {
    const response = await axios.get('https://test.api.amadeus.com/v2/shopping/flight-offers', { params, headers });
    const data = response.data.data;

    // ✅ Parse outbound & return flights
    const outboundFlights = [];
    const returnFlights = [];

    data.forEach(flight => {
      const itineraries = flight.itineraries;

      // Outbound
      if (itineraries[0]) {
        const seg = itineraries[0].segments[0];
        outboundFlights.push({
          flightName: `${seg.carrierCode} ${seg.number}`,
          airline: seg.carrierCode,
          departure: seg.departure.at.split('T')[1].slice(0, 5),
          arrival: seg.arrival.at.split('T')[1].slice(0, 5),
          price: flight.price.total
        });
      }

      // Return (if round trip)
      if (tripType === 'round-trip' && itineraries[1]) {
        const seg = itineraries[1].segments[0];
        returnFlights.push({
          flightName: `${seg.carrierCode} ${seg.number}`,
          airline: seg.carrierCode,
          departure: seg.departure.at.split('T')[1].slice(0, 5),
          arrival: seg.arrival.at.split('T')[1].slice(0, 5),
          price: flight.price.total
        });
      }
    });

    res.json({ outboundFlights, returnFlights });
  } catch (error) {
    console.error('Amadeus error:', error.message);
    res.status(500).json({ error: 'Failed to fetch flights' });
  }
});

app.listen(PORT, () => console.log(`✅ SkyDeal backend running on port ${PORT}`));