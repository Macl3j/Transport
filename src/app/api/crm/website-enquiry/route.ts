import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase';

export const runtime = 'nodejs';

// Server-to-server only. The website must never expose this key to visitors.
export async function POST(req: Request) {
  const secret = process.env.BM_WEBSITE_WEBHOOK_SECRET;
  const token = req.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  if (!secret || secret.length < 32) return NextResponse.json({ error: 'Unavailable' }, { status: 503 });
  if (Buffer.byteLength(token) !== Buffer.byteLength(secret) || !timingSafeEqual(Buffer.from(token), Buffer.from(secret))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    if (!req.headers.get('content-type')?.includes('application/json')) throw new Error('Invalid input');
    const reader = req.body?.getReader();
    if (!reader) throw new Error('Invalid input');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 16000) { await reader.cancel(); throw new Error('Invalid input'); }
      chunks.push(value);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid input');
    const limits: Record<string, number> = { name:150, company:150, email:180, phone:30, from:120, to:120, service:80, date:10, weight:6, pallets:3, cargo:3000, requestId:36 };
    const data: Record<string,string> = {};
    for (const [key, max] of Object.entries(limits)) {
      const value = input[key] ?? '';
      if (typeof value !== 'string' || value.length > max || value.includes('\u0000')) throw new Error('Invalid input');
      data[key] = value.trim();
    }
    if (!data.name || !data.company || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.requestId)) throw new Error('Invalid input');
    const documents = ['Pakiet przewoźnika','Carrier documents'].includes(data.service);
    if (!data.service || (!documents && (!data.from || !data.to))) throw new Error('Invalid input');
    for (const [key,max] of [['weight',100000],['pallets',999]] as const) {
      if (data[key] && (!/^\d+$/.test(data[key]) || Number(data[key]) < 1 || Number(data[key]) > max)) throw new Error('Invalid input');
    }
    if (data.date && (!/^\d{4}-\d{2}-\d{2}$/.test(data.date) || !Number.isFinite(Date.parse(data.date)) || new Date(data.date).toISOString().slice(0,10) !== data.date)) throw new Error('Invalid input');
    const { error } = await createServiceClient().rpc('receive_bm_website_enquiry', { p_request_id:data.requestId, p_data:data });
    if (error) return NextResponse.json({ error:'Could not save enquiry' }, { status:503 });
    return NextResponse.json({ ok:true });
  } catch {
    return NextResponse.json({ error:'Invalid enquiry' }, { status:400 });
  }
}
