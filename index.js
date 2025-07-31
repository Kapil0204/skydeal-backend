// index.js
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------------------------
// /search - Real Flights from Amadeus
// ---------------------------
app.post('/search', async (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body;

  try {
    // 1. Get access token
    const tokenRes = await axios.post(
      'https://test.api.amadeus.com/v1/security/oauth2/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.AMADEUS_CLIENT_ID,
        client_secret: process.env.AMADEUS_CLIENT_SECRET
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const token = tokenRes.data.access_token;

    // 2. Build query params
    const params = {
      originLocationCode: from,
      destinationLocationCode: to,
      departureDate,
      adults: passengers,
      travelClass,
      currencyCode: 'INR',
      max: 30 // fetch more flights
    };

    if (tripType === 'round-trip' && returnDate) {
      params.returnDate = returnDate;
    }

    // 3. Fetch flights
    const response = await axios.get(
      'https://test.api.amadeus.com/v2/shopping/flight-offers',
      {
        headers: { Authorization: `Bearer ${token}` },
        params
      }
    );

    const flights = response.data.data.map(offer => {
      const segments = offer.itineraries[0].segments;
      const firstSegment = segments[0];
      const lastSegment = segments[segments.length - 1];

      return {
        flightNumber: `${firstSegment.carrierCode} ${firstSegment.number}`,
        departure: firstSegment.departure.at,
        arrival: lastSegment.arrival.at,
        price: `₹${offer.price.total}`
      };
    });

    res.json({ flights });
  } catch (error) {
    console.error('❌ Error fetching flights:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch flights from Amadeus' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
