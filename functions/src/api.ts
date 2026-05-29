import { onRequest } from "firebase-functions/v2/https";
import { REGION } from "./config";
import app from "./server";

export const api = onRequest(
  {
    region: REGION,
    memory: "512MiB",
    timeoutSeconds: 60,
  },
  app,
);
