import { neonConfig, Client as NeonClient, Pool as NeonPool } from '@neondatabase/serverless';
import pg from 'pg';
import ws from 'ws';

/**
 * Postgres driver choice. Default: node-postgres over TCP 5432.
 * DB_DRIVER=neon: Neon's serverless driver (same API as pg) over WebSockets on 443 — for hosts whose
 * outbound 5432 to Neon is dropped (seen from Render's free tier). Neon databases only.
 */
const useNeon = () => process.env.DB_DRIVER === 'neon';
if (useNeon()) neonConfig.webSocketConstructor = ws;

export const Pool: typeof pg.Pool = useNeon() ? (NeonPool as unknown as typeof pg.Pool) : pg.Pool;
export const Client: typeof pg.Client = useNeon() ? (NeonClient as unknown as typeof pg.Client) : pg.Client;
