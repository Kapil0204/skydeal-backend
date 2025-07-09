import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());

const cityMap = {
  DEL: "City:delhi_in",
  BOM: "City:mumbai_in",
  BLR: "City:bangalore_in",
  HYD: "City:hyderabad_in",
  MAA: "City:chennai_in",
  CCU: "City:kolkata_in",
  PNQ: "City:pune_in",
  AMD: "City:ahmedabad_in",
  GOI: "City:goa_in",
  LKO: "City:lucknow_in"
};

app.get("/kiwi", async (req, res) => {
  try {
    const {
      flyFrom,
      to,
      dateFrom,
      dateTo,
      oneWay = "1",
      travelClass = "M",
      adults = "1"
    } = req.query;

    const mappedFlyFrom = cityMap[flyFrom?.toUpperCase()] || flyFrom;
    const mappedTo = cityMap[to?.toUpperCase()] || to;

    const params = {
  source: 'City:mumbai_in',
  destination: 'City:new-delhi_in',
  currency: 'INR',
  locale: 'en',
  adults: '1',
  children: '0',
  infants: '0',
  applyMixedClasses: 'true',
  allowChangeInboundSource: 'true',
  allowChangeInboundDestination: 'true',
  allowReturnFromDifferentCity: 'true',
  allowDifferentStationConnection: 'true',
  enableSelfTransfer: 'true',
  allowOvernightStopover: 'true',
  outbound: 'MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY,SATURDAY,SUNDAY',
  transportTypes: 'FLIGHT',
  contentProviders: 'KIWI,KAYAK,FRESH,DIRECTS',
  limit: '10',
  sort: 'quality',
};



    if (oneWay === "1") {
      params.append("return_from_diff_airport", "false");
      params.append("return_to_diff_airport", "false");
    }

    const url = `https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip?${params.toString()}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
        "X-RapidAPI-Host": "kiwi-com-cheap-flights.p.rapidapi.com"
      }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Failed to fetch data from Kiwi");
    }

    res.json(data);
  } catch (error) {
    console.error("Kiwi API fetch error:", error.message);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
