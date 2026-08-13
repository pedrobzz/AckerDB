import { defineConfig } from "./sdk.ts";

export default defineConfig({
  queueConnection: "runtime-secret-slot",
  hostname: "127.0.0.1",
});
