import { All,Body,Controller,Delete,Get,Inject,Param,Patch,Post,Put,Req,Res,UploadedFile,UseInterceptors,ForbiddenException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request,Response } from 'express';
import { ApiService,User } from './service';
import { JobService } from './jobs';
import { config } from './config';

@Controller('api')
export class ApiController {
 constructor(@Inject(ApiService) private api:ApiService,@Inject(JobService) private jobs:JobService){}
 user(req:Request){return this.api.authenticate(req.headers.authorization);}
 @Get('health') health(){return {ok:true,authMode:config.authMode,storage:process.env.DATABASE_URL?'postgresql':'pglite',queue:process.env.REDIS_URL?'redis':'local'};}
 @Post('auth/local') local(@Body() body:any,@Req() req:Request){const origin=req.headers.origin;if(origin&&!['http://localhost:3000','http://127.0.0.1:3000',config.webUrl].includes(origin))throw new ForbiddenException('Untrusted origin');return this.api.localAuth(body.email);}
 @Get('me') async me(@Req() req:Request){return this.api.me(await this.user(req));}
 @Get('devices') async devices(@Req() r:Request){return this.api.devices(await this.user(r));}
 @Post('devices') async addDevice(@Req() r:Request,@Body() b:any){return this.api.createDevice(await this.user(r),b.name);}
 @Delete('devices/:id') async removeDevice(@Req() r:Request,@Param('id') id:string){return this.api.revokeDevice(await this.user(r),id);}
 @Post('devices/pair') async pair(@Req() r:Request,@Body() b:any){return this.api.pair(await this.user(r),b);}
 @Post('devices/exchange') exchange(@Body() b:any){return this.api.exchange(b);}
 @Get('projects') async projects(@Req() r:Request){return this.api.projects(await this.user(r));}
 @Post('projects') async addProject(@Req() r:Request,@Body() b:any){return this.api.createProject(await this.user(r),b);}
 @Patch('projects/:id') async updateProject(@Req() r:Request,@Param('id') id:string,@Body() b:any){return this.api.patchProject(await this.user(r),id,b);}
 @Delete('projects/:id') async deleteProject(@Req() r:Request,@Param('id') id:string){return this.api.deleteProject(await this.user(r),id);}
 @Get('projects/:id/sessions') async sessions(@Req() r:Request,@Param('id') id:string){return this.api.sessions(await this.user(r),id);}
 @Post('projects/:id/sessions') async createSession(@Req() r:Request,@Param('id') id:string,@Body() b:any){return this.api.createSession(await this.user(r),id,b);}
 @Patch('files/:id') async patchFile(@Req() r:Request,@Param('id') id:string,@Body() b:any){return this.api.patchFile(await this.user(r),id,b);}
 @Get('sessions/:id') async session(@Req() r:Request,@Param('id') id:string){return this.api.session(await this.user(r),id);}
 @Patch('sessions/:id') async patchSession(@Req() r:Request,@Param('id') id:string,@Body() b:any){return this.api.patchSession(await this.user(r),id,b);}
 @Post('sessions/:id/events') async events(@Req() r:Request,@Param('id') id:string,@Body() b:any){return this.api.ingest(await this.user(r),id,b);}
 @Get('sessions/:id/export') async exportSession(@Req() r:Request,@Param('id') id:string){return this.api.session(await this.user(r),id);}
 @Delete('sessions/:id') async deleteSession(@Req() r:Request,@Param('id') id:string){return this.api.deleteSession(await this.user(r),id);}
 @Post('samples') async sample(@Req() r:Request){return this.api.sample(await this.user(r));}
 @Get('articles') async articles(@Req() r:Request){return this.api.articles(await this.user(r));}
 @Post('articles') async createArticle(@Req() r:Request,@Body() b:any){return this.api.createArticle(await this.user(r),b);}
 @Get('articles/:id') async article(@Req() r:Request,@Param('id') id:string){return this.api.owned('articles',id,await this.user(r));}
 @Put('articles/:id') async save(@Req() r:Request,@Param('id') id:string,@Body() b:any){return this.api.saveArticle(await this.user(r),id,b);}
 @Post('articles/:id/complete') async complete(@Req() r:Request,@Param('id') id:string,@Body() b:any){return this.api.completeArticle(await this.user(r),id,b);}
 @Delete('articles/:id') async deleteArticle(@Req() r:Request,@Param('id') id:string){return this.api.deleteArticle(await this.user(r),id);}
 @Get('articles/:id/revisions') async revisions(@Req() r:Request,@Param('id') id:string){return this.api.revisions(await this.user(r),id);}
 @Post('articles/:id/restore') async restore(@Req() r:Request,@Param('id') id:string,@Body() b:any){return this.api.restore(await this.user(r),id,b);}
 @Get('articles/:id/markdown') async markdown(@Req() r:Request,@Param('id') id:string){return this.api.markdown(await this.user(r),id);}
 @Get('articles/:id/preview') async preview(@Req() r:Request,@Param('id') id:string){return this.api.preview(await this.user(r),id);}
 @Get('articles/:id/suggestions') async suggestions(@Req() r:Request,@Param('id') id:string){return this.api.suggestions(await this.user(r),id);}
 @Post('suggestions/:id/resolve') async resolveSuggestion(@Req() r:Request,@Param('id') id:string,@Body() b:any){return this.api.resolveSuggestion(await this.user(r),id,b);}
 @Post('jobs') async createJob(@Req() r:Request,@Body() b:any){return this.jobs.create(await this.user(r),b);}
 @Get('jobs') async allJobs(@Req() r:Request){return this.jobs.all(await this.user(r));}
 @Get('jobs/:id') async job(@Req() r:Request,@Param('id') id:string){return this.jobs.get(await this.user(r),id);}
 @Post('jobs/:id/cancel') async cancelJob(@Req() r:Request,@Param('id') id:string){return this.jobs.cancel(await this.user(r),id);}
 @Post('jobs/:id/retry') async retryJob(@Req() r:Request,@Param('id') id:string){return this.jobs.retry(await this.user(r),id);}
 @Get('jobs/:id/events') async streamJob(@Req() r:Request,@Res() res:Response,@Param('id') id:string){const user=await this.user(r);const job=await this.jobs.get(user,id);this.stream(r,res,user,{jobId:id},job);}
 @Get('sessions/:id/events/stream') async streamSession(@Req() r:Request,@Res() res:Response,@Param('id') id:string){const user=await this.user(r);const session=await this.api.session(user,id);this.stream(r,res,user,{sessionId:id},{type:'connected',summaries:session.summaries});}
 private stream(r:Request,res:Response,user:User,filter:{jobId?:string,sessionId?:string},initial:any){res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('Connection','keep-alive');res.flushHeaders();const send=(data:any)=>res.write(`data: ${JSON.stringify(data)}\n\n`);send(initial);const sub=this.api.changes.subscribe(event=>{if(event.ownerId===user.id&&(!filter.jobId||event.jobId===filter.jobId)&&(!filter.sessionId||event.sessionId===filter.sessionId))send(event.data);});let lastSerialized=JSON.stringify(initial);const poll=setInterval(async()=>{try{const data=filter.jobId?await this.jobs.get(user,filter.jobId):{type:'update',...(await this.api.session(user,filter.sessionId!))};const serialized=JSON.stringify(data);if(serialized!==lastSerialized){lastSerialized=serialized;send(data);}}catch{res.end();}},1000);const timer=setInterval(async()=>{try{await this.api.authenticate(r.headers.authorization);res.write(': heartbeat\n\n');}catch{res.end();}},15000);res.on('close',()=>{clearInterval(timer);clearInterval(poll);sub.unsubscribe();});}
 @Get('ghost') async ghost(@Req() r:Request){return this.api.ghost(await this.user(r));}
 @Post('ghost') async connectGhost(@Req() r:Request,@Body() b:any){return this.api.connectGhost(await this.user(r),b);}
 @Delete('ghost') async disconnectGhost(@Req() r:Request){return this.api.disconnectGhost(await this.user(r));}
 @Get('articles/:id/remote') async remote(@Req() r:Request,@Param('id') id:string){return this.api.remote(await this.user(r),id);}
 @Post('uploads') @UseInterceptors(FileInterceptor('file',{limits:{fileSize:10*1024*1024,files:1}})) async upload(@Req() r:Request,@UploadedFile() f:any){return this.api.upload(await this.user(r),f);}
 @Post('uploads/sign') async signUpload(@Req() r:Request,@Body() b:any){return this.api.signedUpload(await this.user(r),b);}
 @Get('uploads/:id/url') async uploadUrl(@Req() r:Request,@Param('id') id:string){return this.api.uploadUrl(await this.user(r),id);}
 @Get('uploads/:id') async readUpload(@Req() r:Request,@Res() res:Response,@Param('id') id:string){const {upload,buffer}=r.headers.authorization?await this.api.readUpload(await this.user(r),id):await this.api.readSignedUpload(id,r.query);res.setHeader('Content-Type',upload.mime);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','private, max-age=3600');res.send(buffer);}
 @Get('admin') async admin(@Req() r:Request){return this.api.dashboard(await this.user(r));}
 @Patch('admin/settings') async settings(@Req() r:Request,@Body() b:any){return this.api.updateSettings(await this.user(r),b);}
 @Patch('admin/users/:id') async limits(@Req() r:Request,@Param('id') id:string,@Body() b:any){return this.api.setLimits(await this.user(r),id,b);}
 @Get('account/export') async exportAccount(@Req() r:Request){return this.api.accountExport(await this.user(r));}
 @Delete('account') async deleteAccount(@Req() r:Request,@Body() b:any){return this.api.deleteAccount(await this.user(r),b||{});}
 @Post('retention/run') async retention(@Req() r:Request){return this.api.retention(await this.user(r));}
}
