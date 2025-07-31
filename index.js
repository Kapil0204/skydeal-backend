import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --------------------
// Amadeus Real Flights
// --------------------
app.post('/search', async (req, res) => {
  const { from, to, departureDate, travelClass, passengers = 1 } = req.body;

  try {
    // Step 1: Get Amadeus access token
    const tokenRes = await axios.post('https://test.api.amadeus.com/v1/security/oauth2/token', new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.AMADEUS_API_KEY,
      client_secret: process.env.AMADEUS_API_SECRET
    }));

    const accessToken = tokenRes.data.access_token;

    // Step 2: Search flights
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

    // Format flight results
    const formattedFlights = flightData.map((flight) => {
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
    console.error(err.message);
    res.status(500).json({ error: 'Failed to fetch flights' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
