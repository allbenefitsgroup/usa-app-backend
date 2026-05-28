import Stripe from "stripe";

export function createStripeClient(secretKey: string): Stripe {
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }

  return new Stripe(secretKey);
}
