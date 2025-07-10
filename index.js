const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

const simulatedFlights = {
  outbound: [
    {
      id: "1",
      airline: "IndiGo",
      departTime: "10:30",
      arriveTime: "12:45",
      from: "Delhi",
      to: "Mumbai",
    },
    {
      id: "2",
      airline: "Air India",
      departTime: "14:15",
      arriveTime: "16:40",
      from: "Delhi",
      to: "Mumbai",
    },
  ],
  return: [
    {
      id: "3",
      airline: "SpiceJet",
      departTime: "18:00",
      arriveTime: "20:20",
      from: "Mumbai",
      to: "Delhi",
    },
    {
      id: "4",
      airline: "Vistara",
      departTime: "21:00",
      arriveTime: "23:15",
      from: "Mumbai",
      to: "Delhi",
    },
  ],
};

const offers = {
  "IndiGo": { MMT: 4500, Goibibo: 4700, EaseMyTrip: 4400 },
  "Air India": { MMT: 5000, Goibibo: 4950, EaseMyTrip: 5100 },
  "SpiceJet": { MMT: 4300, Goibibo: 4450, EaseMyTrip: 4200 },
  "Vistara": { MMT: 5200, Goibibo: 5100, EaseMyTrip: 5000 },
};

const paymentOffers = {
  MMT: { HDFC: 10, ICICI: 5 },
  Goibibo: { ICICI: 15, SBI: 10 },
  EaseMyTrip: { HDFC: 5, SBI: 20 },
};

app.get("/flights", (req, res) => {
  res.json(simulatedFlights);
});

app.get("/offers", (req, res) => {
  const { airline, paymentMethod } = req.query;
  const portalPrices = offers[airline];
  const portalDiscounts = Object.fromEntries(
    Object.entries(portalPrices).map(([portal, price]) => {
      const discount = paymentOffers[portal]?.[paymentMethod] || 0;
      const final = price - (price * discount) / 100;
      return [portal, Math.round(final)];
    })
  );
  res.json(portalDiscounts);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
