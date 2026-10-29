// Netlify Function: все запросы /api/* попадают сюда. Данные — в Netlify Blobs.
import { getStore } from '@netlify/blobs';
import core from './lib/core.cjs';

const blobs = getStore({ name: 'mastercalc', consistency: 'strong' });
const store = {
  get: (key) => blobs.get(key, { type: 'json' }),
  set: (key, value) => blobs.setJSON(key, value),
};

const handle = core.createApi({ store });

export default async (req) => handle(req);

export const config = { path: '/api/*' };
