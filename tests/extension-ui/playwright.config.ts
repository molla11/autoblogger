import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:'*.spec.ts',timeout:30000,workers:1,use:{headless:true,viewport:{width:1100,height:850}},reporter:'list'});
