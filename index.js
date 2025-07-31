import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

let accessToken = null;
let tokenExpiry = null;

// ----------------------------
// Get Amadeus Access Token
// ----------------------------
async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return accessToken; // Use cached token
  }

  try {
    const response = await axios.post(
      'https://test.api.amadeus.com/v1/security/oauth2/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.AMADEUS_CLIENT_ID,
        client_secret: process.env.AMADEUS_CLIENT_SECRET
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    accessToken = response.data.access_token;
    tokenExpiry = Date.now() + response.data.expires_in * 1000 - 60000; // Refresh 1 min early
    return accessToken;
  } catch (error) {
    console.error('❌ Error getting Amadeus token:', error.response?.data || error.message);
    throw new Error('Failed to get Amadeus access token');
  }
}

// ----------------------------
// Fetch Real Flights from Amadeus
// ----------------------------
app.post('/search', async (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body;

  try {
    const token = await getAccessToken();

    const params = {
      originLocationCode: from,
      destinationLocationCode: to,
      departureDate,
      adults: passengers,
      travelClass,
      currencyCode: 'INR',
      max: 20
    };

    if (tripType === 'round-trip') {
      params.returnDate = returnDate;
    }

    const response = await axios.get('https://test.api.amadeus.com/v2/shopping/flight-offers', {
      headers: { Authorization: `Bearer ${token}` },
      params
    });

    // Extract clean list of flights
    const flights = response.data.data.map((offer) => {
      const itinerary = offer.itineraries[0]; // Only outbound for now
      const segment = itinerary.segments[0]; // First leg
      return {
        airline: segment.carrierCode,
        flightNumber: segment.number,
        departure: segment.departure.at,
        arrival: segment.arrival.at,
        from: segment.departure.iataCode,
        to: segment.arrival.iataCode,
        price: offer.price.total
      };
    });

    res.json({ flights });
  } catch (error) {
    console.error('❌ Error fetching flights from Amadeus:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch real flights' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SkyDeal backend running on port ${PORT}`);
});
