import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ✅ CORS fix to allow requests from Vercel frontend
app.use(cors({
  origin: 'https://skydeal-frontend.vercel.app'
}));

// ----------------------------
// Real Flights (Amadeus API)
// ----------------------------
app.post('/search', async (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass } = req.body;

  const options = {
    method: 'GET',
    url: 'https://test.api.amadeus.com/v2/shopping/flight-offers',
    params: {
      originLocationCode: from,
      destinationLocationCode: to,
      departureDate: departureDate,
      returnDate: returnDate || undefined,
      adults: passengers,
      travelClass,
      currencyCode: 'INR',
      max: 10
    },
    headers: {
      Authorization: `Bearer ${process.env.AMADEUS_ACCESS_TOKEN}`
    }
  };

  try {
    const response = await axios.request(options);

    const flights = response.data.data.map((offer) => {
      const itinerary = offer.itineraries[0].segments[0];
      const flight = {
        airline: itinerary.carrierCode,
        flightNumber: itinerary.number,
        departure: itinerary.departure.at,
        arrival: itinerary.arrival.at,
        price: offer.price.total
      };
      return flight;
    });

    res.json({ flights });
  } catch (error) {
    console.error('Error fetching flights from Amadeus:', error.message);
    res.status(500).json({ error: 'Failed to fetch flights' });
  }
});

// ----------------------------
// Simulated Flights Endpoint
// ----------------------------
app.post('/simulated-flights', (req, res) => {
  const { paymentMethods, tripType } = req.body;

  const bestDeals = {
    'ICICI Bank': { portal: 'MakeMyTrip', offer: '10% off', code: 'SKYICICI10', price: 4900 },
    'HDFC Bank': { portal: 'Goibibo', offer: '12% off', code: 'SKYHDFC12', price: 4700 },
    'Axis Bank': { portal: 'EaseMyTrip', offer: '15% off', code: 'SKYAXIS15', price: 4500 }
  };

  const outboundFlights = [
    {
      flightName: 'IndiGo 6E123',
      departure: '08:00',
      arrival: '10:00',
      bestDeal: bestDeals[paymentMethods[0]] || null
    },
    {
      flightName: 'Air India AI456',
      departure: '12:30',
      arrival: '14:45',
      bestDeal: bestDeals[paymentMethods[0]] || null
    }
  ];

  const returnFlights = tripType === 'round-trip' ? [
    {
      flightName: 'SpiceJet SG789',
      departure: '18:00',
      arrival: '20:00',
      bestDeal: bestDeals[paymentMethods[0]] || null
    },
    {
      flightName: 'Vistara UK321',
      departure: '21:30',
      arrival: '23:50',
      bestDeal: bestDeals[paymentMethods[0]] || null
    }
  ] : [];

  res.json({ outboundFlights, returnFlights });
});

app.listen(PORT, () => {
  console.log(`✅ SkyDeal backend running on port ${PORT}`);
});
