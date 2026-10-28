import { PGlite } from '@electric-sql/pglite';
import { Pool,PoolClient } from 'pg';
import { ConflictException } from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export type Row = Record<string, any>;
export interface Sql { query<T extends Row = Row>(sql: string, values?: any[]): Promise<{rows:T[],rowCount?:number|null,affectedRows?:number}>; }
const entityTables = ['projects','sessions','files','summaries','attempts','revisions','evidence','suggestions','model_runs','ghost_connections','jobs','devices','device_pairs','uploads','metrics'] as const;
export type Table = typeof entityTables[number] | 'articles' | 'users' | 'settings';
export class Database implements Sql {
  private pg?: Pool; private migrationClient?:PoolClient;
  private lite?: PGlite;
  private serial = Promise.resolve();
  constructor(public readonly location = process.env.DATABASE_URL || path.resolve(process.cwd(), '../../.data/postgres')) {}
  async init() {
    if (/^postgres(ql)?:/.test(this.location)) this.pg = new Pool({connectionString:this.location, max:10});
    else { if (this.location !== 'memory://') await mkdir(this.location,{recursive:true}); this.lite = new PGlite(this.location); }
    if(this.pg){this.migrationClient=await this.pg.connect();await this.migrationClient.query('SELECT pg_advisory_lock(73639127)');}
    try{await this.schema(`CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, data jsonb NOT NULL); CREATE TABLE IF NOT EXISTS settings (id text PRIMARY KEY,data jsonb NOT NULL);`);
    for (const table of entityTables) await this.schema(`CREATE TABLE IF NOT EXISTS ${table} (id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, parent_id text, data jsonb NOT NULL); CREATE INDEX IF NOT EXISTS ${table}_owner ON ${table}(owner_id); CREATE INDEX IF NOT EXISTS ${table}_parent ON ${table}(parent_id);`);
    await this.schema(`CREATE TABLE IF NOT EXISTS articles (id text PRIMARY KEY,owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,parent_id text,version integer NOT NULL DEFAULT 1,data jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id text PRIMARY KEY,owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,sequence integer NOT NULL CHECK(sequence>0),data jsonb NOT NULL,UNIQUE(session_id,sequence));
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id,sequence);
      CREATE TABLE IF NOT EXISTS snapshots (id text PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,file_id text NOT NULL REFERENCES files(id) ON DELETE CASCADE,hash text NOT NULL,data jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS edits (id text PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,file_id text NOT NULL REFERENCES files(id) ON DELETE CASCADE,data jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id text PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,file_id text REFERENCES files(id) ON DELETE CASCADE,snapshot_id text,data jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS memos (id text PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,file_id text REFERENCES files(id) ON DELETE CASCADE,data jsonb NOT NULL);`);
    // Supabase client roles receive no policies and cannot reach application rows.
    for (const table of ['users','settings',...entityTables,'articles','events','snapshots','edits','runs','memos']) await this.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    return this;}finally{if(this.migrationClient){await this.migrationClient.query('SELECT pg_advisory_unlock(73639127)');this.migrationClient.release();this.migrationClient=undefined;}}
  }
  private async schema(sql:string){for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await this.query(statement);}
  async query<T extends Row = Row>(sql:string, values:any[]=[]):Promise<{rows:T[],rowCount?:number|null,affectedRows?:number}> { return (this.pg ? await (this.migrationClient||this.pg).query(sql,values) : await this.lite!.query(sql,values)) as any; }
  async transaction<T>(fn:(tx:Sql)=>Promise<T>):Promise<T> {
    if(this.pg){const c=await this.pg.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
    let release!:()=>void;const previous=this.serial;this.serial=new Promise(r=>release=r);await previous;
    try{return await this.lite!.transaction(async(tx)=>fn(tx as any));}finally{release();}
  }
  async withAdvisoryLock<T>(key:string,fn:()=>Promise<T>):Promise<T>{if(!this.pg)return fn();const client=await this.pg.connect();try{await client.query('SELECT pg_advisory_lock(hashtext($1))',[key]);return await fn();}finally{await client.query('SELECT pg_advisory_unlock(hashtext($1))',[key]);client.release();}}
  async close(){await this.pg?.end();await this.lite?.close();}
}
export async function one(sql:Sql,table:Table,id:string,owner?:string){const result=await sql.query(`SELECT data FROM ${table} WHERE id=$1${owner?' AND owner_id=$2':''}`,owner?[id,owner]:[id]);return result.rows[0]?.data;}
export async function list(sql:Sql,table:Table,owner?:string,parent?:string){const clauses:string[]=[],values:string[]=[];if(owner){values.push(owner);clauses.push(`owner_id=$${values.length}`);}if(parent){values.push(parent);clauses.push(`parent_id=$${values.length}`);}const r=await sql.query(`SELECT data FROM ${table}${clauses.length?' WHERE '+clauses.join(' AND '):''}`,values);return r.rows.map(x=>x.data);}
export async function put(sql:Sql,table:Table,data:any,parent?:string){
  if(table==='users'||table==='settings')return sql.query(`INSERT INTO ${table}(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,[data.id,JSON.stringify(data)]);
  const result=table==='articles'
    ?await sql.query(`INSERT INTO articles(id,owner_id,parent_id,version,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=excluded.version WHERE articles.owner_id=excluded.owner_id AND articles.parent_id IS NOT DISTINCT FROM excluded.parent_id RETURNING id`,[data.id,data.ownerId,parent||data.sessionId||null,data.version,JSON.stringify(data)])
    :await sql.query(`INSERT INTO ${table}(id,owner_id,parent_id,data) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET data=excluded.data,parent_id=excluded.parent_id WHERE ${table}.owner_id=excluded.owner_id AND ${table}.parent_id IS NOT DISTINCT FROM excluded.parent_id RETURNING id`,[data.id,data.ownerId,parent||null,JSON.stringify(data)]);
  if(!result.rows.length)throw new ConflictException('ID already belongs to another owner or parent');return result;
}
