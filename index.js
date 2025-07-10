<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SkyDeal Flight Finder</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div class="container">
    <h1>SkyDeal - Flight Offer Finder</h1>
    <form id="flight-form">
      <div class="form-row">
        <input type="text" id="origin" placeholder="From" required />
        <input type="text" id="destination" placeholder="To" required />
      </div>
      <div class="form-row">
        <input type="date" id="departure-date" required />
        <input type="date" id="return-date" />
      </div>
      <div class="form-row">
        <select id="trip-type">
          <option value="oneway">One Way</option>
          <option value="round">Round Trip</option>
        </select>
        <select id="travel-class">
          <option value="Economy">Economy</option>
          <option value="Business">Business</option>
        </select>
        <input type="number" id="passengers" placeholder="Passengers" min="1" value="1" required />
      </div>
      <div class="form-row">
        <label for="payment-method">Preferred Payment Methods:</label>
        <select id="payment-method" multiple>
          <option value="ICICI">ICICI</option>
          <option value="HDFC">HDFC</option>
          <option value="SBI">SBI</option>
          <option value="Axis">Axis</option>
          <option value="Kotak">Kotak</option>
        </select>
      </div>
      <button type="submit">Search Flights</button>
    </form>

    <div id="results">
      <div class="results-section">
        <h2>Outbound Flights</h2>
        <div id="outbound-flights" class="flight-column"></div>
      </div>
      <div class="results-section">
        <h2>Return Flights</h2>
        <div id="return-flights" class="flight-column"></div>
      </div>
    </div>
  </div>

  <div id="offer-modal" class="modal hidden">
    <div class="modal-content">
      <span id="close-modal">&times;</span>
      <h3>Portal-Wise Price Comparison</h3>
      <ul id="modal-offers"></ul>
    </div>
  </div>

  <script src="script.js"></script>
</body>
</html>
