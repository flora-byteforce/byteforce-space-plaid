import fs from 'fs/promises';
import path from 'path';
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- DB setup ---
const db = new Database(process.env.SQLITE_PATH, { verbose: null });
db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT UNIQUE,
  access_token TEXT NOT NULL,
  institution_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cursors (
  item_id TEXT PRIMARY KEY,
  cursor TEXT
);
`);

const insertItem = db.prepare(`
  INSERT OR IGNORE INTO items (item_id, access_token, institution_name)
  VALUES (@item_id, @access_token, @institution_name)
`);
const upsertCursor = db.prepare(`
  INSERT INTO cursors (item_id, cursor) VALUES (@item_id, @cursor)
  ON CONFLICT(item_id) DO UPDATE SET cursor=@cursor
`);
const getCursor = db.prepare('SELECT cursor FROM cursors WHERE item_id = ?');
const getAccessTokens = db.prepare('SELECT item_id, access_token, institution_name FROM items');
const getOneItem = db.prepare('SELECT * FROM items WHERE item_id = ?');

// --- Plaid client ---
const config = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'production'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});
const plaid = new PlaidApi(config);
const MIN_BALANCE_ISO = new Date(Date.now() - 30*24*60*60*1000).toISOString();

// ---- Helpers for dashboard builder ----
const WEB_DIR = path.resolve(__dirname, '../web');
const DASH_JSON = path.join(WEB_DIR, 'dashboard_data.json');
function ymd(date){ return date.toISOString().slice(0,10); }

async function fetchItemSnapshot(row, rangeDays=365) {
  const access_token = row.access_token;
  const end_date = new Date();
  const start_date = new Date(Date.now() - rangeDays*24*60*60*1000);

  // 1) accounts + balances (with fallback)
  let accounts = [];
  try {
    const accRes = await plaid.accountsBalanceGet({ access_token, options: { min_last_updated_datetime: new Date(Date.now() - 30*24*60*60*1000).toISOString() } });
    accounts = accRes.data.accounts;
  } catch (e1) {
    console.error('accountsBalanceGet failed', row.item_id, e1.response?.data || e1.message);
    try {
      const accRes2 = await plaid.accountsGet({ access_token });
      accounts = (accRes2.data.accounts || []).map(a => ({ ...a, balances: a.balances || {} }));
    } catch (e2) {
      console.error('accountsGet failed', row.item_id, e2.response?.data || e2.message);
      // give the caller a minimal snapshot with an error flag
      return { accounts: [], transactions: [], error: 'accounts_failed' };
    }
  }

  // 2) liabilities (best-effort)
  const liabByAccount = {};
  try {
    const L = await plaid.liabilitiesGet({ access_token });
    (L.data.liabilities?.credit || []).forEach(c => {
      liabByAccount[c.account_id] = {
        apr_percentage: c.apr?.apr_percentage ?? null,
        minimum_payment_amount: c.minimum_payment_amount ?? null,
        next_payment_due_date: c.next_payment_due_date ?? null,
      };
    });
    (L.data.liabilities?.student || []).forEach(s => {
      liabByAccount[s.account_id] = {
        apr_percentage: s.interest_rate_percentage ?? null,
        minimum_payment_amount: s.minimum_payment_amount ?? null,
        next_payment_due_date: s.next_payment_due_date ?? null,
      };
    });
    (L.data.liabilities?.mortgage || []).forEach(m => {
      liabByAccount[m.account_id] = {
        apr_percentage: Number(m.interest_rate?.percentage ?? 0),
        minimum_payment_amount: m.next_monthly_payment ?? null,
        next_payment_due_date: m.next_payment_due_date ?? null,
      };
    });
  } catch (e) {
    console.error('liabilitiesGet failed (continuing)', row.item_id, e.response?.data || e.message);
  }

  const acctMap = new Map(accounts.map(a => [a.account_id, a]));
  const instName = row.institution_name || '';

  // 3) transactions (with catch)
  let tx = [];
  try {
    const start = ymd(start_date), end = ymd(end_date);
    let total = 0, offset = 0, pageSize = 500;
    do {
      const resp = await plaid.transactionsGet({
        access_token, start_date: start, end_date: end,
        options: { count: pageSize, offset }
      });
      total = resp.data.total_transactions;
      tx.push(...resp.data.transactions);
      offset += resp.data.transactions.length;
    } while (offset < total);
  } catch (e) {
    console.error('transactionsGet failed (continuing)', row.item_id, e.response?.data || e.message);
  }

  // shape accounts
  const accountsOut = accounts.map(a => ({
    institution: instName,
    name: a.name || a.official_name || a.mask || a.account_id,
    nickname: a.official_name || '',
    mask: a.mask || '',
    type: a.type || '',
    subtype: a.subtype || '',
    balances: a.balances || {},
    liability: liabByAccount[a.account_id] || null,
  }));

  // shape transactions
  const txOut = tx.map(t => {
    const a = acctMap.get(t.account_id);
    return {
      date: t.date,
      name: t.name || t.merchant_name || t.payee || '',
      amount: t.amount,                 // Plaid: positive=credit, negative=debit
      category: t.category || [],
      institution: instName,
      nickname: a?.name || a?.official_name || ''
    };
  });

  return { accounts: accountsOut, transactions: txOut };
}

// ================== ROUTES ==================

// Create Link Token
app.post('/api/create_link_token', async (_req, res) => {
  try {
    const userId = 'local-user-1';
    const redirectUri = process.env.PLAID_REDIRECT_URI || undefined;
    const products = ['transactions','liabilities','assets'];
    const createResp = await plaid.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: 'Byteforce Budget',
      products,
      country_codes: ['US'],
      language: 'en',
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    });
    res.json({ link_token: createResp.data.link_token });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: 'create_link_token_failed' });
  }
});

// Link update-mode
app.post('/api/link_token/update', async (req, res) => {
  try {
    const { item_id, products } = req.body || {};
    const row = getOneItem.get(item_id);
    if (!row) return res.status(404).json({ error: 'unknown_item' });
    const redirectUri = process.env.PLAID_REDIRECT_URI || undefined;
    const upd = await plaid.linkTokenCreate({
      access_token: row.access_token,
      user: { client_user_id: 'local-user-1' },
      client_name: 'Byteforce Budget (Update)',
      products: products || ['transactions','liabilities','assets'],
      country_codes: ['US'],
      language: 'en',
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    });
    res.json({ link_token: upd.data.link_token });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: 'link_update_failed' });
  }
});

// Exchange public_token -> access_token
app.post('/api/exchange_public_token', async (req, res) => {
  try {
    const { public_token, institution_name } = req.body;
    if (!public_token) return res.status(400).json({ error: 'missing_public_token' });
    const exch = await plaid.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = exch.data;
    insertItem.run({ item_id, access_token, institution_name: institution_name || null });
    res.json({ item_id });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: 'exchange_failed' });
  }
});

// List items
app.get('/api/items', (_req, res) => {
  const rows = getAccessTokens.all();
  res.json(rows.map(r => ({ item_id: r.item_id })));
});

// Transactions: sync single
app.post('/api/transactions/sync', async (req, res) => {
  try {
    const { item_id } = req.body;
    if (!item_id) return res.status(400).json({ error: 'missing_item_id' });
    const row = getOneItem.get(item_id);
    if (!row) return res.status(404).json({ error: 'unknown_item' });

    let cursor = getCursor.get(item_id)?.cursor || null;
    let added = [], modified = [], removed = [], hasMore = true;

    while (hasMore) {
      const resp = await plaid.transactionsSync({
        access_token: row.access_token,
        cursor: cursor || undefined,
        count: 500,
      });
      const d = resp.data;
      added.push(...d.added);
      modified.push(...d.modified);
      removed.push(...d.removed);
      cursor = d.next_cursor;
      hasMore = d.has_more;
    }
    upsertCursor.run({ item_id, cursor });
    res.json({ item_id, added_count: added.length, modified_count: modified.length, removed_count: removed.length, sample_added: added.slice(0, 5) });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: 'sync_failed' });
  }
});

// Transactions: sync all
app.post('/api/transactions/sync-all', async (_req, res) => {
  try {
    const rows = getAccessTokens.all();
    const summary = [];
    for (const r of rows) {
      let cursor = getCursor.get(r.item_id)?.cursor || null;
      let added = 0, modified = 0, removed = 0, hasMore = true;
      while (hasMore) {
        const resp = await plaid.transactionsSync({
          access_token: r.access_token,
          cursor: cursor || undefined,
          count: 500,
        });
        const d = resp.data;
        added += d.added.length;
        modified += d.modified.length;
        removed += d.removed.length;
        cursor = d.next_cursor;
        hasMore = d.has_more;
      }
      upsertCursor.run({ item_id: r.item_id, cursor });
      summary.push({ item_id: r.item_id, added, modified, removed });
    }
    res.json({ items: summary, total_added: summary.reduce((a,b)=>a+b.added,0) });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: 'sync_all_failed' });
  }
});

// Transactions: force refresh all
app.post('/api/transactions/refresh-all', async (_req, res) => {
  try {
    const rows = getAccessTokens.all();
    const out = [];
    for (const r of rows) {
      try {
        const resp = await plaid.transactionsRefresh({ access_token: r.access_token });
        out.push({ item_id: r.item_id, request_id: resp.data.request_id });
      } catch (err) {
        out.push({ item_id: r.item_id, error: err.response?.data || err.message });
      }
    }
    res.json({ refreshed: out });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: 'refresh_all_failed' });
  }
});

// Recurring transactions
app.get('/api/transactions/recurring', async (_req, res) => {
  try {
    const rows = getAccessTokens.all();
    const items = [];
    for (const r of rows) {
      try {
        const rec = await plaid.transactionsRecurringGet({ access_token: r.access_token });
        items.push({ item_id: r.item_id, inflow_streams: rec.data.inflow_streams, outflow_streams: rec.data.outflow_streams });
      } catch (err) {
        items.push({ item_id: r.item_id, error: err.response?.data || err.message });
      }
    }
    res.json({ items });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: 'recurring_failed' });
  }
});

// Accounts + balances
app.get('/api/accounts', async (_req, res) => {
  try {
    const rows = getAccessTokens.all();
    const items = [];
    for (const r of rows) {
      try {
        const a = await plaid.accountsGet({ access_token: r.access_token });
        items.push({ item_id: r.item_id, accounts: a.data.accounts });
      } catch (err) {
        items.push({ item_id: r.item_id, error: err.response?.data || err.message });
      }
    }
    res.json({ items });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: 'accounts_failed' });
  }
});

app.get('/api/balances', async (_req, res) => {
  try {
    const rows = getAccessTokens.all();
    const items = [];
    for (const r of rows) {
      try {
        items.push({ item_id: r.item_id, accounts: b.data.accounts });
      } catch (err) {
        try {
          const a = await plaid.accountsGet({ access_token: r.access_token });
          items.push({ item_id: r.item_id, accounts: (a.data.accounts||[]).map(x=>({ ...x, balances: x.balances||{} })) });
        } catch (err2) {
          items.push({ item_id: r.item_id, error: err2.response?.data || err2.message });
        }
      }
    }
    res.json({ items });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: 'balances_failed' });
  }
});

// Liabilities
app.get('/api/liabilities', async (_req, res) => {
  try {
    const rows = getAccessTokens.all();
    const items = [];
    for (const r of rows) {
      try {
        const L = await plaid.liabilitiesGet({ access_token: r.access_token });
        items.push({ item_id: r.item_id, liabilities: L.data.liabilities, accounts: L.data.accounts });
      } catch (err) {
        items.push({ item_id: r.item_id, error: err.response?.data || err.message });
      }
    }
    res.json({ items });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: 'liabilities_failed' });
  }
});

// Assets workflow
app.post('/api/assets/create', async (req, res) => {
  try {
    const days = Number(req.body?.days_requested || 90);
    const access_tokens = getAccessTokens.all().map(r => r.access_token);
    if (access_tokens.length === 0) return res.status(400).json({ error: 'no_items' });
    const ar = await plaid.assetReportCreate({
      access_tokens,
      days_requested: days,
      options: { client_report_id: `byteforce-${Date.now()}`, include_insights: true }
    });
    res.json({ asset_report_token: ar.data.asset_report_token, asset_report_id: ar.data.asset_report_id });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/assets/get', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'missing token' });
    const r = await plaid.assetReportGet({ asset_report_token: String(token) });
    res.json(r.data);
  } catch (e) {
    res.status(202).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/assets/pdf', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).send('missing token');
    const pdf = await plaid.assetReportPdfGet(
      { asset_report_token: String(token) },
      { responseType: 'arraybuffer' }
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(pdf.data));
  } catch (e) {
    res.status(500).send(typeof e === 'string' ? e : (e.response?.data || e.message));
  }
});

app.post('/api/assets/remove', async (req, res) => {
  try {
    const token = req.body?.token;
    if (!token) return res.status(400).json({ error: 'missing token' });
    const r = await plaid.assetReportRemove({ asset_report_token: token });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// Enrich (optional for non-Plaid transactions)
app.post('/api/enrich', async (req, res) => {
  try {
    const { transactions } = req.body || {};
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: 'provide transactions[]' });
    }
    const out = await plaid.transactionsEnrich({ transactions });
    res.json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// OAuth redirect page
app.get('/oauth-redirect', (_req, res) => {
  res.sendFile(`${__dirname}/../web/oauth-redirect.html`);
});

// Serve static frontend
app.get('/dashboard_data.json', async (req, res) => {
  try {
    const p = path.resolve(__dirname, '../web/dashboard_data.json');
    const data = await fs.readFile(p, 'utf-8');
    res.set('Cache-Control','no-store');
    res.type('application/json').send(data);
  } catch (e) {
    res.status(404).json({ error: 'not_found', detail: String(e && e.message || e) });
  }
});
app.use('/', express.static(`${__dirname}/../web`));

// ===== Dashboard data builder: /refresh_dashboard =====
app.post('/refresh_dashboard', async (req, res) => {
  try {
    const hdr = req.get('X-Refresh-Token') || '';
    if (!process.env.DASHBOARD_REFRESH_TOKEN || hdr !== process.env.DASHBOARD_REFRESH_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const items = getAccessTokens.all();
    // Optional: force Plaid to pull fresh data first
    for (const r of items) {
      try { await plaid.transactionsRefresh({ access_token: r.access_token }); } catch (e) {
        console.error('transactionsRefresh failed (continuing)', r.item_id, e.response?.data || e.message);
      }
    }

    // Build per-item snapshots, but never fail the whole run
    const snapshots = [];
    for (const r of items) {
      try {
        const snap = await fetchItemSnapshot(r, 365);
        snapshots.push({ item_id: r.item_id, ...snap });
      } catch (e) {
        console.error('snapshot failed (continuing)', r.item_id, e.response?.data || e.message);
        snapshots.push({ item_id: r.item_id, accounts: [], transactions: [], error: 'snapshot_failed' });
      }
    }

    const accounts = snapshots.flatMap(s => s.accounts);
    const transactions = snapshots.flatMap(s => s.transactions);
    const out = { last_updated: new Date().toISOString(), accounts, transactions, errors: snapshots.filter(s => s.error) };

    await fs.writeFile(DASH_JSON, JSON.stringify(out, null, 2));
    return res.json({ ok: true, accounts: accounts.length, transactions: transactions.length, errors: out.errors.length });
  } catch (e) {
    console.error('refresh_dashboard failed (top-level)', e.response?.data || e.message);
    return res.status(500).json({ error: 'refresh_dashboard_failed' });
  }
});

// ---- Start the server (loopback only) ----
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => {
  const url = process.env.BASE_URL || `http://${host}:${port}`;
  console.log(`Server listening on ${url}`);
});
