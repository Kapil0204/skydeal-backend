import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 🔑 Get Amadeus access token
async function getAccessToken() {
  const url = 'https://test.api.amadeus.com/v1/security/oauth2/token';
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.AMADEUS_CLIENT_ID,
    client_secret: process.env.AMADEUS_CLIENT_SECRET
  });

  const response = await axios.post(url, body);
  return response.data.access_token;
}

// ✈️ Format flights
function formatFlight(itinerary, price, flight) {
  const segment = itinerary.segments[0];
  return {
    flightNumber: `${segment.carrierCode} ${segment.number}`,
    airlineName: segment.carrierCode,
    departure: segment.departure.at.slice(11, 16),
    arrival: segment.arrival.at.slice(11, 16),
    price: price.total,
    stops: itinerary.segments.length - 1
  };
}

app.post('/search', async (req, res) => {
  try {
    const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body;
    const token = await getAccessToken();

    console.log(`🔐 Got token, fetching flights from ${from} to ${to} on ${departureDate} (${tripType})`);

    const params = {
      originLocationCode: from,
      destinationLocationCode: to,
      departureDate,
      returnDate: tripType === 'round-trip' ? returnDate : undefined,
      adults: passengers,
      travelClass,
      currencyCode: 'INR',
      nonStop: false,
      max: 100,
  
    };

    const response = await axios.get('https://test.api.amadeus.com/v2/shopping/flight-offers', {
      headers: { Authorization: `Bearer ${token}` },
      params
    });

    const rawFlights = response.data.data;
    console.log(`📦 Found ${rawFlights.length} total flights from Amadeus`);

    const outboundFlights = [];
    const returnFlights = [];

  rawFlights.forEach(flight => {
  const itineraries = flight.itineraries;
  const price = flight.price;

  // Skip flights where first carrier is Air India
  const firstSegment = itineraries[0]?.segments[0];

  if (tripType === 'round-trip' && itineraries.length === 2) {
    outboundFlights.push(formatFlight(itineraries[0], price, flight));
    returnFlights.push(formatFlight(itineraries[1], price, flight));
  } else if (tripType === 'one-way' && itineraries.length === 1) {
    outboundFlights.push(formatFlight(itineraries[0], price, flight));
  }
});


    console.log(`✈️ Outbound: ${outboundFlights.length} | Return: ${returnFlights.length}`);

    res.json({ outboundFlights, returnFlights });
  } catch (err) {
    if (err.response) {
  console.error('❌ Amadeus fetch error:', JSON.stringify(err.response.data, null, 2));

} else {
  console.error('❌ Amadeus fetch error:', err.message);
}

    res.status(500).json({ error: 'Failed to fetch flights' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
