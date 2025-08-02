import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// --------------------------
// /search (Amadeus flights)
// --------------------------
app.post('/search', async (req, res) => {
  const {
    from,
    to,
    departureDate,
    returnDate,
    tripType,
    passengers,
    travelClass
  } = req.body;

  try {
    // Step 1: Get access token from Amadeus
    const authResponse = await axios.post(
      'https://test.api.amadeus.com/v1/security/oauth2/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.AMADEUS_CLIENT_ID,
        client_secret: process.env.AMADEUS_CLIENT_SECRET
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    console.log("✅ Auth success:", authResponse.status, authResponse.data);
    const accessToken = authResponse.data.access_token;

    // Step 2: Call Amadeus flight offers API
    const searchResponse = await axios.get(
      'https://test.api.amadeus.com/v2/shopping/flight-offers',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        params: {
          originLocationCode: from,
          destinationLocationCode: to,
          departureDate,
          returnDate: tripType === 'round-trip' ? returnDate : undefined,
          adults: passengers,
          travelClass,
          currencyCode: 'INR',
          max: 30
        }
      }
    );

    const flights = searchResponse.data.data;

    // Simplify flight info
    const simplifiedFlights = flights.map((flight) => {
      const itinerary = flight.itineraries[0];
      const segment = itinerary.segments[0];
      return {
        airline: segment.carrierCode,
        flightNumber: segment.number,
        departure: segment.departure.at,
        arrival: segment.arrival.at,
        price: flight.price.total
      };
    });

    res.json({ flights: simplifiedFlights });
  } catch (error) {
    console.error("❌ Failed to fetch flights");
    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Data:", error.response.data);
    } else {
      console.error("Error:", error.message);
    }
    console.error("🔍 Env CLIENT_ID:", process.env.AMADEUS_CLIENT_ID);
    console.error("🔍 Env CLIENT_SECRET:", process.env.AMADEUS_CLIENT_SECRET);

    res.status(500).json({ error: 'Failed to fetch flights' });
  }
});

app.listen(PORT, () => {
  console.log(`🟢 SkyDeal backend running on port ${PORT}`);
});
