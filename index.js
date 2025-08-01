import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ----------------------------
// Amadeus Flight Search Route
// ----------------------------
app.post('/search', async (req, res) => {
  const { from, to, departureDate, travelClass, passengers = 1 } = req.body;

  console.log('🔍 Incoming Search Request:', { from, to, departureDate, travelClass, passengers });

  try {
    // Step 1: Get access token from Amadeus
    const tokenRes = await axios.post(
      'https://test.api.amadeus.com/v1/security/oauth2/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.AMADEUS_API_KEY,
        client_secret: process.env.AMADEUS_API_SECRET
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    const accessToken = tokenRes.data.access_token;
    console.log('✅ Access token received.');

    // Step 2: Fetch flight offers
    const flightRes = await axios.get('https://test.api.amadeus.com/v2/shopping/flight-offers', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        originLocationCode: from,
        destinationLocationCode: to,
        departureDate,
        adults: passengers,
        travelClass,
        currencyCode: 'INR',
        max: 20
      }
    });

    const flightData = flightRes.data.data;
    console.log(`✈️ Received ${flightData.length} flight offers.`);

    // Step 3: Format results
    const formattedFlights = flightData.map(flight => {
      const itinerary = flight.itineraries[0];
      const segment = itinerary.segments[0];
      const price = flight.price.total;

      return {
        flightNumber: segment.carrierCode + segment.number,
        airline: segment.carrierCode,
        departure: segment.departure.at,
        arrival: segment.arrival.at,
        price
      };
    });

    res.json({ flights: formattedFlights });

  } catch (err) {
    console.error('❌ Error in /search:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch flights' });
  }
});

// ----------------------------
app.listen(PORT, () => {
  console.log(`🚀 SkyDeal backend running on port ${PORT}`);
});
