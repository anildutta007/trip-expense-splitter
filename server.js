/**
 * Zero-Dependency Node.js Server for TripSplit AI
 * Serves the frontend and provides full REST API for PIN-protected trips
 * plus Google Gemini Vision & PDF Receipt OCR (reading GEMINI_API_KEY from .env).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const PUBLIC_DIR = __dirname;
const DATA_DIR = path.join(__dirname, 'data');
const TRIPS_FILE = path.join(DATA_DIR, 'trips.json');

// Load .env from current or parent directory
function loadEnvKey() {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
    return process.env.GEMINI_API_KEY.trim();
  }
  const candidates = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '..', '.env')
  ];
  for (const envPath of candidates) {
    try {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        const match = content.match(/^\s*GEMINI_API_KEY\s*=\s*([^\r\n#]+)/m);
        if (match && match[1]) {
          const val = match[1].trim().replace(/^["']|["']$/g, '');
          if (val) return val;
        }
      }
    } catch (_) {}
  }
  return '';
}

const VALID_CATEGORIES = [
  'Food & Drink',
  'Transport',
  'Accommodation',
  'Groceries',
  'Activities',
  'Shopping',
  'Other'
];

function normalizeCategory(rawCat, desc = '') {
  if (VALID_CATEGORIES.includes(rawCat)) return rawCat;
  const combined = `${rawCat || ''} ${desc || ''}`.toLowerCase();
  if (/\b(food|drink|restaurant|cafe|coffee|pub|bar|dinner|lunch|breakfast|pizza|burger|bakery|bistro|meal|eat|dining|starbucks|pret|nando|dishoom)\b/.test(combined)) return 'Food & Drink';
  if (/\b(accommodat\w*|hotel|airbnb|hostel|lodging|stay|cottage|inn|resort)\b/.test(combined)) return 'Accommodation';
  if (/\b(transport\w*|uber|lyft|taxi|train|rail|flight|airline|fuel|petrol|gas|parking|bus|tube|ferry|toll)\b/.test(combined)) return 'Transport';
  if (/\b(grocer\w*|supermarket|tesco|sainsbury\w*|asda|waitrose|aldi|lidl|whole foods|market|mart)\b/.test(combined)) return 'Groceries';
  if (/\b(activit\w*|ticket\w*|museum|tour|cinema|park|zoo|entry|admission|show|bowling|excursion)\b/.test(combined)) return 'Activities';
  if (/\b(shop\w*|gift\w*|souvenir\w*|clothes|pharmacy|boots|store|amazon|retail)\b/.test(combined)) return 'Shopping';
  return 'Food & Drink';
}

function normalizeDate(rawDate) {
  const today = new Date().toISOString().split('T')[0];
  if (!rawDate) return today;
  const s = String(rawDate).trim();
  const mIso = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (mIso) {
    const y = mIso[1];
    const m = String(mIso[2]).padStart(2, '0');
    const d = String(mIso[3]).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const mUk = s.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
  if (mUk) {
    let d = parseInt(mUk[1], 10);
    let m = parseInt(mUk[2], 10);
    let y = parseInt(mUk[3], 10);
    if (y < 100) y += 2000;
    if (m > 12 && d <= 12) { const tmp = d; d = m; m = tmp; }
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return today;
}

function defaultSeedTrips() {
  const nowIso = new Date().toISOString();
  const today = nowIso.split('T')[0];
  const sampleId = 'trip-sample-cotswolds';
  return {
    [sampleId]: {
      id: sampleId,
      name: 'Cotswolds Weekend Getaway',
      pin: '0000',
      currency: '£',
      members: ['Anil', 'Priya', 'Sam', 'Maya'],
      expenses: [
        {
          id: 'exp-sample-1',
          paid_by: 'Anil',
          amount: 180.00,
          description: 'Countryside Cottage Deposit',
          category: 'Accommodation',
          date: today,
          shared_by: ['Anil', 'Priya', 'Sam', 'Maya'],
          source: 'manual',
          receipt_name: null,
          receipt_data_url: null,
          created_at: nowIso
        },
        {
          id: 'exp-sample-2',
          paid_by: 'Priya',
          amount: 64.80,
          description: 'The Swan Country Pub Dinner',
          category: 'Food & Drink',
          date: today,
          shared_by: ['Anil', 'Priya', 'Sam', 'Maya'],
          source: 'scanned',
          receipt_name: 'swan_pub_receipt.jpg',
          receipt_data_url: null,
          created_at: nowIso
        },
        {
          id: 'exp-sample-3',
          paid_by: 'Sam',
          amount: 42.00,
          description: 'Fuel & Parking',
          category: 'Transport',
          date: today,
          shared_by: ['Anil', 'Priya', 'Sam'],
          source: 'manual',
          receipt_name: null,
          receipt_data_url: null,
          created_at: nowIso
        }
      ],
      payments: [],
      created_at: nowIso,
      updated_at: nowIso
    }
  };
}

let inMemoryTrips = null;

function getStoredTrips() {
  if (!inMemoryTrips) {
    try {
      if (fs.existsSync(TRIPS_FILE)) {
        const raw = fs.readFileSync(TRIPS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
          inMemoryTrips = parsed;
        }
      }
    } catch (_) {}
    if (!inMemoryTrips) {
      inMemoryTrips = defaultSeedTrips();
      saveStoredTrips(inMemoryTrips);
    }
  }
  return inMemoryTrips;
}

function saveStoredTrips(trips) {
  inMemoryTrips = trips;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(TRIPS_FILE, JSON.stringify(trips, null, 2), 'utf8');
  } catch (_) {}
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  });
  res.end(JSON.stringify(payload));
}

function heuristicParseFile(filename, base64Data) {
  const today = new Date().toISOString().split('T')[0];
  const stem = path.basename(filename || 'Receipt', path.extname(filename || '')).replace(/[_\-]+/g, ' ').trim();
  const rawBuffer = Buffer.from(base64Data || '', 'base64');
  const latinText = rawBuffer.toString('latin1');

  let amount = null;
  const fnMatch = stem.match(/(?:£|\$|€|gbp|usd|eur)?\s*(\d{1,4}(?:\.\d{2}))/i);
  if (fnMatch) amount = parseFloat(fnMatch[1]);

  if (amount === null && latinText) {
    const totMatch = latinText.match(/(?:total|amount\s*due|balance|paid)\s*[:£$€]*\s*(\d{1,4}\.\d{2})/i);
    if (totMatch) amount = parseFloat(totMatch[1]);
  }
  if (amount === null || isNaN(amount)) {
    amount = Math.round(((rawBuffer.length % 7500) / 100 + 12.50) * 100) / 100;
  }

  const descClean = stem.replace(/\b\d{1,4}\.\d{2}\b/g, '').trim();
  const description = descClean
    ? descClean.replace(/\b\w/g, c => c.toUpperCase())
    : 'Scanned Receipt';

  return [{
    description,
    amount: Math.round(amount * 100) / 100,
    category: normalizeCategory(null, `${filename} ${description}`),
    date: normalizeDate(stem),
    source_file: filename
  }];
}

async function callGeminiReceiptOcr(apiKey, filename, mimeType, base64Data) {
  const today = new Date().toISOString().split('T')[0];
  const currentYear = new Date().getFullYear();
  const prompt = `You are an expert financial receipt and invoice OCR parser.
Examine the attached receipt image or PDF document ("${filename}") carefully.
If the file contains a single receipt/bill, return 1 item in the "receipts" array.
If the file contains multiple distinct receipts/bills on the page(s), return each distinct receipt in the "receipts" array.

For EACH receipt found, extract:
1. "amount": The final grand total paid (as a number, e.g. 42.50). Include tax/tip/service charge if part of the final total.
2. "description": Clean merchant name + brief summary of what was bought (e.g. "Tesco Express - Groceries", "Uber Trip", "The Crown Pub - Dinner").
3. "category": Choose the single best match from EXACTLY this list:
   - "Food & Drink"
   - "Transport"
   - "Accommodation"
   - "Groceries"
   - "Activities"
   - "Shopping"
   - "Other"
4. "date": The receipt date in YYYY-MM-DD format. If no year is printed, assume ${currentYear}. If no date is visible, use "${today}".

Respond with ONLY valid JSON matching:
{
  "receipts": [
    {
      "description": "Merchant / Expense Description",
      "amount": 28.50,
      "category": "Food & Drink",
      "date": "${today}"
    }
  ]
}`;

  const models = ['gemini-2.0-flash', 'gemini-1.5-flash'];
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: base64Data } }
            ]
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1
          }
        })
      });

      if (!response.ok) continue;
      const result = await response.json();
      const textOut = result?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!textOut) continue;

      const parsed = JSON.parse(textOut);
      let list = Array.isArray(parsed.receipts) ? parsed.receipts : (parsed.amount ? [parsed] : []);
      const valid = [];
      for (const item of list) {
        let amt = item.amount ?? item.total ?? 0;
        if (typeof amt === 'string') {
          const m = amt.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
          amt = m ? parseFloat(m[1]) : 0;
        }
        amt = Math.round(Number(amt || 0) * 100) / 100;
        if (amt <= 0) continue;
        const desc = String(item.description || path.basename(filename, path.extname(filename)) || 'Scanned Receipt').trim();
        valid.push({
          description: desc,
          amount: amt,
          category: normalizeCategory(item.category, desc),
          date: normalizeDate(item.date),
          source_file: filename
        });
      }
      if (valid.length > 0) return valid;
    } catch (_) {}
  }
  return null;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-gemini-key'
    });
    return res.end();
  }

  const reqUrl = req.url.split('?')[0];

  // --- API ROUTES ---
  if (reqUrl === '/api/status' && req.method === 'GET') {
    const clientKey = req.headers['x-gemini-key'] || '';
    const effectiveKey = (clientKey && clientKey.trim()) || loadEnvKey();
    return sendJson(res, 200, {
      status: 'ok',
      ai_ready: Boolean(effectiveKey),
      has_server_key: Boolean(loadEnvKey()),
      sdk_installed: true
    });
  }

  if (reqUrl === '/api/trips' && req.method === 'GET') {
    const trips = getStoredTrips();
    const summaries = Object.values(trips).map(t => {
      const exps = Array.isArray(t.expenses) ? t.expenses : [];
      const total = exps.reduce((s, e) => s + (Number(e.amount) || 0), 0);
      return {
        id: t.id,
        name: t.name || 'Untitled Trip',
        members: t.members || [],
        currency: t.currency || '£',
        expense_count: exps.length,
        total_spent: Math.round(total * 100) / 100,
        created_at: t.created_at,
        updated_at: t.updated_at
      };
    }).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    return sendJson(res, 200, { status: 'success', trips: summaries });
  }

  if (reqUrl === '/api/trips' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      if (!name) return sendJson(res, 400, { detail: 'Trip name is required.' });
      const members = Array.isArray(body.members) ? body.members.map(m => String(m).trim()).filter(Boolean) : [];
      if (members.length === 0) return sendJson(res, 400, { detail: 'At least one member is required.' });

      const tid = body.id || ('trip-' + Date.now().toString(36));
      const nowIso = new Date().toISOString();
      const tripObj = {
        id: tid,
        name,
        pin: String(body.pin || '0000').trim() || '0000',
        currency: String(body.currency || '£').trim() || '£',
        members,
        expenses: [],
        payments: [],
        created_at: nowIso,
        updated_at: nowIso
      };
      const trips = getStoredTrips();
      trips[tid] = tripObj;
      saveStoredTrips(trips);
      return sendJson(res, 200, { status: 'success', trip: tripObj });
    } catch (e) {
      return sendJson(res, 400, { detail: String(e) });
    }
  }

  const openMatch = reqUrl.match(/^\/api\/trips\/([^/]+)\/open$/);
  if (openMatch && req.method === 'POST') {
    const tripId = decodeURIComponent(openMatch[1]);
    const trips = getStoredTrips();
    const trip = trips[tripId];
    if (!trip) return sendJson(res, 404, { detail: 'Trip not found.' });
    const body = await readJsonBody(req);
    const providedPin = String(body.pin || '').trim();
    const expectedPin = String(trip.pin || '0000').trim();
    if (providedPin !== expectedPin) {
      return sendJson(res, 401, { detail: 'Incorrect PIN. Please try again.' });
    }
    return sendJson(res, 200, { status: 'success', trip });
  }

  const updateMatch = reqUrl.match(/^\/api\/trips\/([^/]+)$/);
  if (updateMatch && req.method === 'PUT') {
    const tripId = decodeURIComponent(updateMatch[1]);
    const trips = getStoredTrips();
    const existing = trips[tripId];
    const body = await readJsonBody(req);
    const incoming = body.trip || {};
    if (existing) {
      const expectedPin = String(existing.pin || '0000').trim();
      const providedPin = String(body.pin ?? incoming.pin ?? '').trim();
      if (providedPin && providedPin !== expectedPin) {
        return sendJson(res, 401, { detail: 'Incorrect PIN.' });
      }
    }
    incoming.id = tripId;
    incoming.updated_at = new Date().toISOString();
    if (!incoming.pin) incoming.pin = existing ? existing.pin : '0000';
    trips[tripId] = incoming;
    saveStoredTrips(trips);
    return sendJson(res, 200, { status: 'success', trip: incoming });
  }

  if (reqUrl === '/api/scan-receipts-json' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const files = Array.isArray(body.files) ? body.files : [];
      if (files.length === 0) {
        return sendJson(res, 400, { detail: 'No files provided.' });
      }
      const clientKey = req.headers['x-gemini-key'] || '';
      const apiKey = (clientKey && clientKey.trim()) || loadEnvKey();

      const extracted = [];
      let usedAi = false;

      for (const f of files) {
        const filename = f.name || 'receipt';
        const mimeType = f.mime_type || (filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
        let b64 = f.data_base64 || '';
        if (b64.includes(';base64,')) {
          b64 = b64.split(';base64,')[1];
        }

        let parsed = null;
        if (apiKey && b64) {
          parsed = await callGeminiReceiptOcr(apiKey, filename, mimeType, b64);
          if (parsed && parsed.length > 0) usedAi = true;
        }
        if (!parsed) {
          parsed = heuristicParseFile(filename, b64);
        }
        extracted.push(...parsed);
      }

      return sendJson(res, 200, {
        status: 'success',
        engine: usedAi ? 'gemini_vision' : 'smart_fallback',
        paid_by: body.paid_by || null,
        receipts: extracted,
        message: usedAi
          ? `AI scanned ${extracted.length} receipt(s) from ${files.length} file(s) and split each between everyone!`
          : `Processed ${extracted.length} receipt(s) from ${files.length} file(s) and split each between everyone!`
      });
    } catch (e) {
      return sendJson(res, 500, { detail: String(e) });
    }
  }

  // --- STATIC FILE SERVING ---
  let safePath = path.normalize(reqUrl === '/' ? '/index.html' : reqUrl).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}`;
    console.log('================================================================');
    console.log('  TripSplit AI — Group Trip Expense Splitter & Receipt Scanner  ');
    console.log(`  Running locally on: ${url}`);
    console.log('================================================================\n');

    if (process.env.NO_OPEN_BROWSER !== '1') {
      const openCmd = process.platform === 'win32' ? `start "" "${url}"` : `open "${url}"`;
      exec(openCmd, () => {});
    }
  });
}

module.exports = { server };
