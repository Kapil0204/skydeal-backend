import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from your frontend on Vercel
app.use(cors({
  origin: 'https://skydeal-frontend.vercel.app'
}));

app.use(express.json());

// ----------------------
// Simulated Flights Route
// ----------------------
app.post('/simulated-flights', (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass, paymentMethods, tripType } = req.body;

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
      bestDeal: bestDeals[paymentMethods?.[0]] || null
    },
    {
      flightName: 'Air India AI456',
      departure: '12:30',
      arrival: '14:45',
      bestDeal: bestDeals[paymentMethods?.[0]] || null
    }
  ];

  const returnFlights = tripType === 'round-trip' ? [
    {
      flightName: 'SpiceJet SG789',
      departure: '18:00',
      arrival: '20:00',
      bestDeal: bestDeals[paymentMethods?.[0]] || null
    },
    {
      flightName: 'Vistara UK321',
      departure: '21:30',
      arrival: '23:50',
      bestDeal: bestDeals[paymentMethods?.[0]] || null
    }
  ] : [];

  res.json({ outboundFlights, returnFlights });
});

// ----------------------
// Default Route
// ----------------------
app.get('/', (req, res) => {
  res.send('SkyDeal backend is running');
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
