require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;
const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

// CORS: restrict to your GitHub Pages origin in production
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || true }));
app.use(bodyParser.json());

// helper to read/write bookings
async function loadBookings() {
  try {
    await fs.ensureFile(BOOKINGS_FILE);
    const raw = await fs.readFile(BOOKINGS_FILE, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('loadBookings error', e);
    return {};
  }
}
async function saveBookings(b) {
  await fs.writeFile(BOOKINGS_FILE, JSON.stringify(b, null, 2));
}

// Pricing calculator (same rules you used in front-end)
function computeTotal(payload) {
  const plan = payload.plan; // 'hourly', 'day', 'night'
  const hours = payload.hours || 2;
  let planPrice = 0;
  if (plan === 'hourly') planPrice = 198 * (hours || 2);
  else if (plan === 'day') planPrice = 999;
  else if (plan === 'night') planPrice = 1499;

  // games: most-expensive free, extras charged (payload.games = [{name,price},...])
  const games = Array.isArray(payload.games) ? payload.games.map(g => ({ name: g.name, price: Number(g.price || 0) })) : [];
  games.sort((a,b)=> b.price - a.price);
  let gameTotal = 0;
  const gameBreakdown = [];
  games.forEach((g, idx)=>{
    if (idx === 0) gameBreakdown.push({ name: g.name, price: g.price, free: true });
    else { gameTotal += g.price; gameBreakdown.push({ name: g.name, price: g.price, free: false }); }
  });

  // controller
  let controllerCharge = 0;
  if (payload.addController) {
    if (plan === 'hourly') controllerCharge = 39 * (hours || 2);
    else if (plan === 'day') controllerCharge = 199;
    else if (plan === 'night') controllerCharge = 299;
  }

  // delivery charge by city
  const cityDeliveryPrices = { "Neemuch": 199, "Pratapgarh": 199, "Mandsaur": 99 };
  let deliveryCharge = cityDeliveryPrices[payload.city] || 99;

  // coupons (simple: 'leazo')
  let couponDiscount = 0;
  if ((payload.coupon || '').toLowerCase() === 'leazo') {
    if (['Pratapgarh','Neemuch'].includes(payload.city)) {
      if (plan === 'day') couponDiscount = 400;
      else if (plan === 'night') couponDiscount = 700;
    } else {
      if (plan === 'hourly') couponDiscount = 0.5 * planPrice;
      if (plan === 'day') couponDiscount = 500;
      if (plan === 'night') couponDiscount = 800;
    }
  }

  // payment method discount (UPI)
  const subtotal = planPrice + controllerCharge + gameTotal + deliveryCharge;
  const afterCoupon = Math.max(subtotal - couponDiscount, 0);
  let upiDiscount = 0;
  if ((payload.paymentMethod || 'cod') === 'upi') upiDiscount = Math.round(afterCoupon * 0.05);
  const total = Math.max(afterCoupon - upiDiscount, 0);

  return {
    planPrice, controllerCharge, gameTotal, deliveryCharge, couponDiscount, upiDiscount, total,
    gameBreakdown
  };
}

// Create order endpoint (called by your frontend)
app.post('/create-order', async (req, res) => {
  try {
    const payload = req.body;

    // minimal validation (expand as needed)
    const must = ['plan','games','bookingDate','name','phone','address','city','paymentMethod'];
    for (const f of must) {
      if (!payload[f]) return res.status(400).json({ error: `Missing ${f}` });
    }

    const calc = computeTotal(payload);
    const amount = Number(calc.total);
    if (isNaN(amount)) return res.status(400).json({ error: 'Invalid amount' });

    // create your internal order id
    const orderId = `LEAZO_${Date.now()}_${Math.floor(Math.random()*9000+1000)}`;

    // Cashfree endpoint (sandbox vs production)
    const apiUrl = (process.env.CF_ENV === 'PRODUCTION')
      ? 'https://api.cashfree.com/pg/orders'
      : 'https://sandbox.cashfree.com/pg/orders';

    const requestBody = {
      order_currency: 'INR',
      order_amount: amount,
      customer_details: {
        customer_id: payload.phone || orderId,
        customer_name: payload.name || '',
        customer_email: payload.email || '',
        customer_phone: payload.phone
      },
      // set return & webhook / notify URLs
      order_meta: {
        return_url: process.env.RETURN_URL || `${process.env.FRONTEND_ORIGIN || ''}/?order_id=${orderId}`
      },
      notify_url: process.env.WEBHOOK_URL || `${process.env.BACKEND_ORIGIN || ''}/webhook`,
      order_id: orderId
    };

    const headers = {
      'Content-Type': 'application/json',
      'x-api-version': process.env.CF_API_VERSION || '2025-01-01',
      'x-client-id': process.env.CF_CLIENT_ID || '',
      'x-client-secret': process.env.CF_CLIENT_SECRET || ''
    };

    const cfRes = await axios.post(apiUrl, requestBody, { headers });

    // Cashfree returns a payment_session_id in the response
    const sessionId = cfRes.data?.payment_session_id || cfRes.data?.paymentSessionId || null;

    // persist booking
    const bookings = await loadBookings();
    bookings[orderId] = {
      orderId,
      payload,
      calc,
      amount,
      status: payload.paymentMethod === 'cod' ? 'booked_cod' : 'pending_payment',
      createdAt: new Date().toISOString(),
      cashfreeResponse: cfRes.data
    };
    await saveBookings(bookings);

    // return session id & our orderId to client
    return res.json({ success: true, orderId, amount, paymentSessionId: sessionId });
  } catch (err) {
    console.error('/create-order error', err?.response?.data || err.message || err);
    res.status(500).json({ error: 'server_error', detail: err?.response?.data || err.message });
  }
});

// Webhook endpoint (Cashfree will POST here). We use raw body to verify signature correctly.
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const rawBody = req.body.toString();
    const signature = req.headers['x-webhook-signature'] || req.headers['x-cashfree-signature'] || '';
    const timestamp = req.headers['x-webhook-timestamp'] || req.headers['x-cashfree-timestamp'] || '';

    // verify signature: Base64(HMAC_SHA256(timestamp + rawBody, clientSecret))
    const expected = crypto.createHmac('sha256', process.env.CF_CLIENT_SECRET || '').update(timestamp + rawBody).digest('base64');
    if (!signature || signature !== expected) {
      console.warn('Invalid webhook signature', { expected, signature });
      return res.status(400).send('invalid signature');
    }

    const payload = JSON.parse(rawBody);
    const orderId = payload.order_id || payload.orderId || payload.data?.order_id;
    const orderStatus = payload.order_status || payload.status || payload.data?.order_status || '';

    const bookings = await loadBookings();
    if (orderId && bookings[orderId]) {
      const statusStr = String(orderStatus).toUpperCase();
      let newStatus = 'pending';
      if (statusStr.includes('SUCCESS') || statusStr.includes('PAID')) newStatus = 'paid';
      else if (statusStr.includes('FAILED')) newStatus = 'failed';
      bookings[orderId].status = newStatus;
      bookings[orderId].webhook = payload;
      bookings[orderId].updatedAt = new Date().toISOString();
      await saveBookings(bookings);
      console.log(`Booking ${orderId} updated to ${newStatus}`);
    } else {
      console.warn('Webhook for unknown order', orderId);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error('webhook handler error', e);
    return res.status(500).send('server error');
  }
});

// fetch booking
app.get('/booking/:orderId', async (req, res) => {
  const bookings = await loadBookings();
  const b = bookings[req.params.orderId];
  if (!b) return res.status(404).json({ error: 'not found' });
  return res.json(b);
});

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
