from fastapi import FastAPI, APIRouter, HTTPException, Query
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Optional, List
import os, uuid, logging

WIB = ZoneInfo('Asia/Jakarta')

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')
client = AsyncIOMotorClient(os.environ['MONGO_URL'])
db = client[os.environ['DB_NAME']]
app = FastAPI(title='themakeupguru Packing API')
api = APIRouter(prefix='/api')

class ScanCreate(BaseModel):
    tanggal: str = Field(min_length=10, max_length=10)
    nomor_pesanan: str = Field(min_length=1, max_length=120)
    nama_packer: str = Field(min_length=1, max_length=100)
    nama_ekspedisi: str = Field(min_length=1, max_length=100)

class ScanUpdate(BaseModel):
    tanggal: str
    nomor_pesanan: str
    nama_packer: str
    nama_ekspedisi: str

class SettingCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)

def clean_scan(doc):
    return {k: doc[k] for k in ('id','tanggal','waktu_scan','nomor_pesanan','nama_packer','nama_ekspedisi','created_at')}

@app.on_event('startup')
async def setup_db():
    await db.scans.create_index([('tanggal', 1), ('nomor_pesanan', 1)], unique=True)
    await db.settings.create_index([('kind', 1), ('name', 1)], unique=True)

@api.get('/')
async def root(): return {'message': 'themakeupguru siap digunakan'}

@api.get('/settings')
async def get_settings():
    docs = await db.settings.find({}, {'_id': 0}).sort('name', 1).to_list(500)
    return {'packers': [x['name'] for x in docs if x['kind'] == 'packer'], 'expeditions': [x['name'] for x in docs if x['kind'] == 'expedition']}

@api.post('/settings/{kind}')
async def add_setting(kind: str, payload: SettingCreate):
    if kind not in ('packer', 'expedition'): raise HTTPException(400, 'Jenis pengaturan tidak valid')
    name = payload.name.strip()
    try:
        await db.settings.insert_one({'kind': kind, 'name': name})
    except Exception:
        raise HTTPException(409, 'Nama sudah tersedia')
    return {'name': name}

@api.delete('/settings/{kind}/{name}')
async def delete_setting(kind: str, name: str):
    await db.settings.delete_one({'kind': kind, 'name': name})
    return {'ok': True}

@api.post('/scans')
async def create_scan(payload: ScanCreate):
    now = datetime.now(WIB)
    doc = {**payload.model_dump(), 'id': str(uuid.uuid4()), 'waktu_scan': now.strftime('%H:%M:%S'), 'created_at': now.isoformat()}
    try: await db.scans.insert_one(doc.copy())
    except Exception as exc:
        if 'duplicate' in str(exc).lower(): raise HTTPException(409, 'Nomor pesanan sudah tercatat hari ini.')
        raise
    return clean_scan(doc)

@api.get('/scans')
async def list_scans(tanggal: Optional[str] = None, packer: Optional[str] = None, ekspedisi: Optional[str] = None, search: Optional[str] = None, limit: int = Query(500, le=2000)):
    q = {}
    if tanggal: q['tanggal'] = tanggal
    if packer: q['nama_packer'] = packer
    if ekspedisi: q['nama_ekspedisi'] = ekspedisi
    if search: q['nomor_pesanan'] = {'$regex': search, '$options': 'i'}
    docs = await db.scans.find(q, {'_id': 0}).sort('created_at', -1).to_list(limit)
    return [clean_scan(x) for x in docs]

@api.get('/stats')
async def stats(tanggal: str):
    docs = await db.scans.find({'tanggal': tanggal}, {'_id': 0, 'nama_packer': 1, 'nama_ekspedisi': 1}).to_list(5000)
    def count(key):
        out = {}
        for d in docs: out[d[key]] = out.get(d[key], 0) + 1
        return [{'name': k, 'count': v} for k, v in sorted(out.items(), key=lambda x: (-x[1], x[0]))]
    return {'total': len(docs), 'packers': count('nama_packer'), 'expeditions': count('nama_ekspedisi')}

@api.put('/scans/{scan_id}')
async def update_scan(scan_id: str, payload: ScanUpdate):
    existing = await db.scans.find_one({'id': scan_id}, {'_id': 0})
    if not existing: raise HTTPException(404, 'Data tidak ditemukan')
    clash = await db.scans.find_one({'tanggal': payload.tanggal, 'nomor_pesanan': payload.nomor_pesanan, 'id': {'$ne': scan_id}}, {'_id': 0})
    if clash: raise HTTPException(409, 'Nomor pesanan sudah tercatat pada tanggal tersebut')
    await db.scans.update_one({'id': scan_id}, {'$set': payload.model_dump()})
    return clean_scan({**existing, **payload.model_dump()})

@api.delete('/scans/{scan_id}')
async def delete_scan(scan_id: str):
    result = await db.scans.delete_one({'id': scan_id})
    if not result.deleted_count: raise HTTPException(404, 'Data tidak ditemukan')
    return {'ok': True}

app.include_router(api)
app.add_middleware(CORSMiddleware, allow_credentials=True, allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','), allow_methods=['*'], allow_headers=['*'])
logging.basicConfig(level=logging.INFO)

@app.on_event('shutdown')
async def shutdown_db_client(): client.close()