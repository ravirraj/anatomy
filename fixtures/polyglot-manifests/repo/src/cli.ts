import { pad } from "./index.ts";

const databaseUrl = process.env.DATABASE_URL;
const apiKey = process.env["API_KEY"];
const region = import.meta.env.VITE_REGION;

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl,
  apiKey,
  region,
};

export function run(): string {
  return pad(String(config.port));
}
