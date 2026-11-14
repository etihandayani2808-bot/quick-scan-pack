const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_URL;
const dbName = process.env.DB_NAME || 'themakeupguru_packing';

let cachedClient = null;

async function connectToDatabase() {
  if (!uri) throw new Error('MONGO_URL belum terpasang di Vercel');
  if (!cachedClient) {
    cachedClient = new MongoClient(uri, {
      maxPoolSize: 1,
      serverSelectionTimeoutMS: 5000,
    });
  }
  await cachedClient.connect();
  return cachedClient.db(dbName);
}

function getWIBNow() {
  const now = new Date();
  const wibTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  const pad = (n) => String(n).padStart(2, '0');
  const waktu_scan = `${pad(wibTime.getHours())}:${pad(wibTime.getMinutes())}:${pad(wibTime.getSeconds())}`;
  return { waktu_scan, created_at: now.toISOString() };
}

function cleanScan(doc) {
  return {
    id: doc.id,
    tanggal: doc.tanggal,
    waktu_scan: doc.waktu_scan,
    nomor_pesanan: doc.nomor_pesanan,
    nama_packer: doc.nama_packer,
    nama_ekspedisi: doc.nama_ekspedisi,
    created_at: doc.created_at,
  };
}

app.get('/api', (req, res) => {
  res.json({ message: 'themakeupguru siap digunakan' });
});

app.get('/api/settings', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const docs = await db.collection('settings').find({}, { projection: { _id: 0 } }).sort({ name: 1 }).toArray();
    res.json({
      packers: docs.filter((x) => x.kind === 'packer').map((x) => x.name),
      expeditions: docs.filter((x) => x.kind === 'expedition').map((x) => x.name),
    });
  } catch (err) {
    cachedClient = null;
    res.status(500).json({ detail: 'Gagal memuat data: ' + err.message });
  }
});

app.post('/api/settings/:kind', async (req, res) => {
  const { kind } = req.params;
  if (kind !== 'packer' && kind !== 'expedition') {
    return res.status(400).json({ detail: 'Jenis pengaturan tidak valid' });
  }
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ detail: 'Nama tidak boleh kosong' });
  try {
    const db = await connectToDatabase();
    const existing = await db.collection('settings').findOne({ kind, name });
    if (existing) {
      return res.status(409).json({ detail: 'Nama sudah tersedia' });
    }
    await db.collection('settings').insertOne({ kind, name });
    res.json({ name });
  } catch (err) {
    cachedClient = null;
    res.status(500).json({ detail: 'Gagal menyimpan ke database: ' + err.message });
  }
});

app.delete('/api/settings/:kind/:name', async (req, res) => {
  try {
    const db = await connectToDatabase();
    await db.collection('settings').deleteOne({ kind: req.params.kind, name: decodeURIComponent(req.params.name) });
    res.json({ ok: true });
  } catch (err) {
    cachedClient = null;
    res.status(500).json({ detail: err.message });
  }
});

app.post('/api/scans', async (req, res) => {
  const { tanggal, nomor_pesanan, nama_packer, nama_ekspedisi } = req.body;
  const { waktu_scan, created_at } = getWIBNow();
  const doc = {
    id: crypto.randomUUID(),
    tanggal,
    nomor_pesanan,
    nama_packer,
    nama_ekspedisi,
    waktu_scan,
    created_at,
  };
  try {
    const db = await connectToDatabase();
    const existing = await db.collection('scans').findOne({ tanggal, nomor_pesanan });
    if (existing) {
      return res.status(409).json({ detail: 'Nomor pesanan sudah tercatat hari ini.' });
    }
    await db.collection('scans').insertOne({ ...doc });
    res.json(cleanScan(doc));
  } catch (err) {
    cachedClient = null;
    res.status(500).json({ detail: 'Gagal menyimpan scan: ' + err.message });
  }
});

app.get('/api/scans', async (req, res) => {
  const { tanggal, packer, ekspedisi, search, limit = 500 } = req.query;
  const q = {};
  if (tanggal) q.tanggal = tanggal;
  if (packer) q.nama_packer = packer;
  if (ekspedisi) q.nama_ekspedisi = ekspedisi;
  if (search) q.nomor_pesanan = { $regex: search, $options: 'i' };
  try {
    const db = await connectToDatabase();
    const docs = await db.collection('scans').find(q, { projection: { _id: 0 } }).sort({ created_at: -1 }).limit(Number(limit)).toArray();
    res.json(docs.map(cleanScan));
  } catch (err) {
    cachedClient = null;
    res.status(500).json({ detail: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  const { tanggal } = req.query;
  try {
    const db = await connectToDatabase();
    const docs = await db.collection('scans').find({ tanggal }, { projection: { _id: 0, nama_packer: 1, nama_ekspedisi: 1 } }).toArray();
    const count = (key) => {
      const out = {};
      docs.forEach((d) => {
        out[d[key]] = (out[d[key]] || 0) + 1;
      });
      return Object.entries(out)
        .sort((a, b) => b - a || a.localeCompare(b))
        .map(([name, c]) => ({ name, count: c }));
    };
    res.json({ total: docs.length, packers: count('nama_packer'), expeditions: count('nama_ekspedisi') });
  } catch (err) {
    cachedClient = null;
    res.status(500).json({ detail: err.message });
  }
});

app.put('/api/scans/:scan_id', async (req, res) => {
  const { scan_id } = req.params;
  const { tanggal, nomor_pesanan, nama_packer, nama_ekspedisi } = req.body;
  try {
    const db = await connectToDatabase();
    const existing = await db.collection('scans').findOne({ id: scan_id }, { projection: { _id: 0 } });
    if (!existing) return res.status(404).json({ detail: 'Data tidak ditemukan' });
    const clash = await db.collection('scans').findOne({ tanggal, nomor_pesanan, id: { $ne: scan_id } });
    if (clash) return res.status(409).json({ detail: 'Nomor pesanan sudah tercatat pada tanggal tersebut' });
    await db.collection('scans').updateOne({ id: scan_id }, { $set: { tanggal, nomor_pesanan, nama_packer, nama_ekspedisi } });
    res.json(cleanScan({ ...existing, tanggal, nomor_pesanan, nama_packer, nama_ekspedisi }));
  } catch (err) {
    cachedClient = null;
    res.status(500).json({ detail: err.message });
  }
});

app.delete('/api/scans/:scan_id', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const result = await db.collection('scans').deleteOne({ id: req.params.scan_id });
    if (!result.deletedCount) return res.status(404).json({ detail: 'Data tidak ditemukan' });
    res.json({ ok: true });
  } catch (err) {
    cachedClient = null;
    res.status(500).json({ detail: err.message });
  }
});

module.exports = app;
