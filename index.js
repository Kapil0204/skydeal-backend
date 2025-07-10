import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/simulate-flights', (req, res) => {
  const flights = [
    { name: 'IndiGo', dep: '08:30', arr: '10:45' },
    { name: 'Air India', dep: '09:00', arr: '11:20' },
    { name: 'SpiceJet', dep: '13:15', arr: '15:30' }
  ];
  res.json({ outbound: flights, return: flights });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

