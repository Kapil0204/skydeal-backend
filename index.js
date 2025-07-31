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
// 1. Real Flights from Amadeus
// ---------------------------
app.post('/search', async (req, res) => {
  const { from, to, departureDate, passengers, travelClass } = req.body;

  try {
    // 1. Auth to Amadeus
    const authResponse = await axios.post('https://test.api.amadeus.com/v1/security/oauth2/token', null, {
      params: {
        grant_type: 'client_credentials',
        client_id: process.env.AMADEUS_API_KEY,
        client_secret: process.env.AMADEUS_API_SECRET,
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    });

    const accessToken = authResponse.data.access_token;

    // 2. Fetch flights
    const searchUrl = 'https://test.api.amadeus.com/v2/shopping/flight-offers';
    const flightResponse = await axios.get(searchUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params: {
        originLocationCode: from,
        destinationLocationCode: to,
        departureDate: departureDate,
        adults: passengers,
        travelClass: travelClass,
        currencyCode: 'INR',
        max: 10
      }
    });

    const flights = flightResponse.data.data.map((offer, index) => {
      const segment = offer.itineraries[0].segments[0];
      const airline = segment.carrierCode;
      const departure = segment.departure.at;
      const arrival = segment.arrival.at;
      const flightNumber = segment.flightNumber;
      const basePrice = parseFloat(offer.price.total);

      return {
        index,
        airline,
        departure,
        arrival,
        flightNumber,
        basePrice,
        otaPrices: {
          MakeMyTrip: basePrice + 100,
          Goibibo: basePrice + 100,
          EaseMyTrip: basePrice + 100,
          Yatra: basePrice + 100
        }
      };
    });

    res.json({ flights });

  } catch (err) {
    console.error('Error fetching flights:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch flight data from Amadeus' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SkyDeal backend running on port ${PORT}`);
});
