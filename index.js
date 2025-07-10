import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/simulated-flights', (req, res) => {
  res.json({
    outbound: [
      {
        airline: 'IndiGo',
        departure: '08:00',
        arrival: '10:30',
        portals: {
          MMT: { price: 3200, payment: 'ICICI Credit Card' },
          Goibibo: { price: 3400, payment: 'HDFC Debit Card' },
        },
      },
      {
        airline: 'Air India Express',
        departure: '14:00',
        arrival: '16:30',
        portals: {
          MMT: { price: 3100, payment: 'HDFC Credit Card' },
          Goibibo: { price: 3300, payment: 'ICICI Debit Card' },
        },
      },
    ],
    return: [
      {
        airline: 'SpiceJet',
        departure: '11:00',
        arrival: '13:30',
        portals: {
          MMT: { price: 3500, payment: 'SBI Credit Card' },
          Goibibo: { price: 3700, payment: 'HDFC Credit Card' },
        },
      },
      {
        airline: 'Vistara',
        departure: '17:00',
        arrival: '19:30',
        portals: {
          MMT: { price: 3600, payment: 'ICICI Credit Card' },
          Goibibo: { price: 3900, payment: 'SBI Debit Card' },
        },
      },
    ]
  });
});

app.listen(PORT, () => {
  console.log(`Simulated SkyDeal API running on port ${PORT}`);
});
