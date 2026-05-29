import { onRequest } from "firebase-functions/v2/https";
import { REGION, stripeSecretKey, stripeWebhookSecret, emailApiKey, jwtSecret } from "./config";
import app from "./server";

export const api = onRequest(
  {
    region: REGION,
    secrets: [stripeSecretKey, stripeWebhookSecret, emailApiKey, jwtSecret] as any,
  },
  app,
);
