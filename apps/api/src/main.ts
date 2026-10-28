import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import express from "express";
import { ApiController } from "./controller";
import { ApiService } from "./service";
import { JobService } from "./jobs";
import { config } from "./config";
@Module({
  controllers: [ApiController],
  providers: [
    { provide: ApiService, useFactory: () => new ApiService().init() },
    {
      provide: JobService,
      inject: [ApiService],
      useFactory: (api: ApiService) => new JobService(api).init(),
    },
  ],
})
class AppModule {}
export async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: ["error", "warn", "log"],
  });
  app.use(express.json({ limit: "8mb" }));
  app.use((req: any, res: any, next: any) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.enableCors({
    origin: [config.webUrl, "http://127.0.0.1:3000"],
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });
  await app.listen(config.port, config.host);
  console.log(
    `Autoblogger API http://${config.host}:${config.port}/api (${config.authMode})`,
  );
  const close = async () => {
    await app.get(JobService).close();
    await app.get(ApiService).close();
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return app;
}
if (!process.env.API_NO_AUTOSTART) void bootstrap();
