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
// Amadeus Auth Token
// --------------------
let amadeusToken = null;

async function getAmadeusToken() {
  const options = {
    method: 'POST',
    url: 'https://test.api.amadeus.com/v1/security/oauth2/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.AMADEUS_API_KEY,
      client_secret: process.env.AMADEUS_API_SECRET
    })
  };

  try {
    const response = await axios.request(options);
    amadeusToken = response.data.access_token;
  } catch (error) {
    console.error('❌ Failed to get Amadeus token:', error.message);
  }
}

// --------------------
// /search Endpoint
// --------------------
app.post('/search', async (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body;

  if (!amadeusToken) await getAmadeusToken();

  const amadeusOptions = {
    method: 'GET',
    url: 'https://test.api.amadeus.com/v2/shopping/flight-offers',
    headers: { Authorization: `Bearer ${amadeusToken}` },
    params: {
      originLocationCode: from,
      destinationLocationCode: to,
      departureDate,
      returnDate: tripType === 'round-trip' ? returnDate : undefined,
      adults: passengers,
      travelClass: travelClass.toUpperCase(),
      currencyCode: 'INR',
      max: 10
    }
  };

  try {
    const response = await axios.request(amadeusOptions);
    const flightData = response.data.data;

    const outboundFlights = flightData.map((offer, idx) => {
      const segment = offer.itineraries[0].segments[0];
      return {
        flightName: `${segment.carrierCode} ${segment.number}`,
        departure: segment.departure.at.slice(11, 16),
        arrival: segment.arrival.at.slice(11, 16),
        price: offer.price.total
      };
    });

    const returnFlights = tripType === 'round-trip'
      ? flightData.map((offer, idx) => {
          const returnSegment = offer.itineraries[1]?.segments[0];
          return returnSegment
            ? {
                flightName: `${returnSegment.carrierCode} ${returnSegment.number}`,
                departure: returnSegment.departure.at.slice(11, 16),
                arrival: returnSegment.arrival.at.slice(11, 16),
                price: offer.price.total
              }
            : null;
        }).filter(Boolean)
      : [];

    res.json({ outboundFlights, returnFlights });

  } catch (error) {
    console.error('❌ Amadeus API Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch real flights' });
  }
});

// ----------------------
// Simulated OTA Prices
// ----------------------
app.post('/simulate-prices', (req, res) => {
  const { basePrice } = req.body;
  const base = parseFloat(basePrice || 0);

  const markup = 100;
  const portals = [
    { name: 'MakeMyTrip', price: base + markup },
    { name: 'Goibibo', price: base + markup },
    { name: 'EaseMyTrip', price: base + markup }
  ];

  res.json({ portals });
});

app.listen(PORT, () => {
  console.log(`🚀 SkyDeal backend running on port ${PORT}`);
});
