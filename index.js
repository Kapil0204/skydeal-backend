import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ----------------------
// Real Flights from Amadeus
// ----------------------
app.post('/search', async (req, res) => {
  const {
    origin,
    destination,
    departureDate,
    returnDate,
    passengers,
    travelClass,
    tripType
  } = req.body;

  try {
    // Step 1: Get access token
    const tokenResponse = await axios.post('https://test.api.amadeus.com/v1/security/oauth2/token', new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.AMADEUS_CLIENT_ID,
      client_secret: process.env.AMADEUS_CLIENT_SECRET
    }));

    const accessToken = tokenResponse.data.access_token;

    // Step 2: Call Amadeus flight API
    const amadeusResponse = await axios.get('https://test.api.amadeus.com/v2/shopping/flight-offers', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params: {
        originLocationCode: origin,
        destinationLocationCode: destination,
        departureDate,
        returnDate: tripType === 'round-trip' ? returnDate : undefined,
        adults: passengers,
        travelClass,
        currencyCode: 'INR',
        max: 30
      }
    });

    const flights = amadeusResponse.data.data;

    // Parse flights into frontend-friendly format
    const parseFlights = (flightData, isReturn = false) => {
      return flightData.map(offer => {
        const itinerary = offer.itineraries[isReturn ? 1 : 0];
        const segment = itinerary?.segments?.[0];
        const lastSegment = itinerary?.segments?.[itinerary.segments.length - 1];

        return {
          airline: segment?.carrierCode || 'Unknown',
          flightNumber: `${segment?.carrierCode || 'XX'} ${segment?.number || '000'}`,
          departure: segment?.departure?.at?.slice(11, 16) || '00:00',
          arrival: lastSegment?.arrival?.at?.slice(11, 16) || '00:00',
          price: Math.round(offer.price.total)
        };
      }).filter(f => f.airline !== 'Unknown'); // Clean results
    };

    const outboundFlights = parseFlights(flights, false);
    const returnFlights = tripType === 'round-trip' ? parseFlights(flights, true) : [];

    res.json({ outboundFlights, returnFlights });

  } catch (error) {
    console.error('❌ Error in /search:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch flights' });
  }
});

// ----------------------
// Start Server
// ----------------------
app.listen(PORT, () => {
  console.log(`✅ SkyDeal backend running at http://localhost:${PORT}`);
});
