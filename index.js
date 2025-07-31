import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('SkyDeal backend is running');
});

// ===========================
// Real Flights – Amadeus API
// ===========================
app.post('/search', async (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass } = req.body;
  console.log('[SkyDeal] Search request received:', req.body);

  try {
    // Step 1: Get Amadeus token
    const authResponse = await axios.post(
      'https://test.api.amadeus.com/v1/security/oauth2/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.AMADEUS_CLIENT_ID,
        client_secret: process.env.AMADEUS_CLIENT_SECRET
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const accessToken = authResponse.data.access_token;
    console.log('[SkyDeal] Amadeus access token acquired');

    // Step 2: Fetch flights
    const response = await axios.get(
      'https://test.api.amadeus.com/v2/shopping/flight-offers',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          originLocationCode: from,
          destinationLocationCode: to,
          departureDate,
          returnDate: returnDate || undefined,
          adults: passengers,
          travelClass,
          currencyCode: 'INR',
          max: 10
        }
      }
    );

    const flights = response.data.data || [];
    console.log(`[SkyDeal] ${flights.length} flight(s) received`);

    res.json({ flights });
  } catch (error) {
    console.error('[SkyDeal] Error fetching flights:', error.message);

    // Optional: log full response
    if (error.response) {
      console.error('Details:', error.response.data);
    }

    res.status(500).json({ error: 'Failed to fetch flights from Amadeus' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SkyDeal backend running on port ${PORT}`);
});
