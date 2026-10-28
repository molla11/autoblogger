import { config as dotenv } from 'dotenv';
import path from 'node:path';
import { existsSync } from 'node:fs';
for(const file of [path.resolve(process.cwd(),'.env.local'),path.resolve(process.cwd(),'../../.env.local')])if(existsSync(file))dotenv({path:file,quiet:true});
export const config = {
  authMode:process.env.AUTH_MODE || 'local',
  host:process.env.API_HOST || '127.0.0.1',
  port:Number(process.env.API_PORT || 4000),
  webUrl:process.env.WEB_URL || 'http://localhost:3000',
  dataDir:path.resolve(process.env.DATA_DIR || (process.cwd().endsWith('apps/api')?'../../.data':'.data')),
  production:process.env.NODE_ENV==='production',
};
export function validateConfig(){
  if(config.authMode==='local'&&(config.production||!['127.0.0.1','::1','localhost'].includes(config.host)))throw new Error('Local authentication is permitted only on loopback outside production');
  if(config.production&&(!process.env.DATABASE_URL||!process.env.REDIS_URL||!process.env.ENCRYPTION_KEY||!process.env.SUPABASE_URL))throw new Error('Production requires DATABASE_URL, REDIS_URL, ENCRYPTION_KEY and SUPABASE_URL');
}
