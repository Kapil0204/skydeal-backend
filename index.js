// skydeal-backend/index.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// POST /search - Real flights from Amadeus
app.post('/search', async (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body;

  const tokenOptions = {
    method: 'POST',
    url: 'https://test.api.amadeus.com/v1/security/oauth2/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.AMADEUS_CLIENT_ID,
      client_secret: process.env.AMADEUS_CLIENT_SECRET
    })
  };

  try {
    const tokenRes = await axios.request(tokenOptions);
    const token = tokenRes.data.access_token;

    const searchParams = new URLSearchParams({
      originLocationCode: from,
      destinationLocationCode: to,
      departureDate,
      adults: passengers,
      travelClass,
      currencyCode: 'INR',
      max: 10
    });

    if (tripType === 'round-trip' && returnDate) {
      searchParams.append('returnDate', returnDate);
    }

    const flightOptions = {
      method: 'GET',
      url: `https://test.api.amadeus.com/v2/shopping/flight-offers?${searchParams.toString()}`,
      headers: { Authorization: `Bearer ${token}` }
    };

    const flightRes = await axios.request(flightOptions);
    const offers = flightRes.data.data || [];

    const flights = offers.map((offer) => {
      const itinerary = offer.itineraries[0];
      const segment = itinerary.segments[0];
      const flight = segment.flightSegment || segment;
      return {
        airline: flight.carrierCode,
        flightNumber: flight.number,
        departure: flight.departure.at,
        arrival: flight.arrival.at,
        basePrice: parseInt(offer.price.total),
        id: offer.id
      };
    });

    res.json({ flights });
  } catch (err) {
    console.error('Amadeus API error:', err.message);
    res.status(500).json({ error: 'Failed to fetch flight data from Amadeus' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ SkyDeal backend running on port ${PORT}`);
});
