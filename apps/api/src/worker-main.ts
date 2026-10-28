import 'reflect-metadata';
import { ApiService } from './service';
import { JobService } from './jobs';
async function main(){if(!process.env.REDIS_URL)throw new Error('Separate worker requires REDIS_URL (local dev runs jobs in API)');const api=await new ApiService().init();const jobs=await new JobService(api).init(true);console.log('Autoblogger worker ready');const close=async()=>{await jobs.close();await api.close();process.exit(0);};process.on('SIGINT',close);process.on('SIGTERM',close);}
void main();
