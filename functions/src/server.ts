import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { auth } from "./firebase";
import {
  handleSyncUserProfile,
  handleCreateCheckoutSession,
  handleGetMyCourseAccess,
  handleStripeWebhook,
  handleRequestProductInfo,
  handleSendWhatsappNotification,
} from "./index";

const app = express();

// Stripe webhook needs raw body before any JSON parser
const stripeWebhookPath = "/stripeWebhook";

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === stripeWebhookPath) {
    express.raw({ type: "application/json" })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

app.use(cors({ origin: true }));

// Auth middleware for callable-like endpoints
async function verifyAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
  }
  try {
    const token = authHeader.split("Bearer ")[1];
    const decoded = await auth.verifyIdToken(token);
    (req as any).authContext = { uid: decoded.uid, token: decoded };
    next();
  } catch (e) {
    return res.status(401).json({ error: { message: "Invalid token", status: "UNAUTHENTICATED" } });
  }
}

// Helper to wrap callable handlers for Express
function wrapCallable(handler: (req: any) => Promise<any>, requiresAuth = true) {
  return async (req: Request, res: Response) => {
    try {
      if (requiresAuth) {
        const authContext = (req as any).authContext;
        if (!authContext) {
          return res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
        }
      }

      const request = {
        data: req.body.data || req.body,
        auth: (req as any).authContext || undefined,
        rawRequest: req,
      };

      const result = await handler(request);
      res.json({ result });
    } catch (error: any) {
      console.error("Handler error:", error);
      if (error.code && error.message) {
        res.json({ error: { message: error.message, status: error.code } });
      } else {
        res.json({ error: { message: error.message || "Internal error", status: "INTERNAL" } });
      }
    }
  };
}

// Callable-like endpoints
app.post("/api/syncUserProfile", verifyAuth, wrapCallable(handleSyncUserProfile));
app.post("/api/createCheckoutSession", verifyAuth, wrapCallable(handleCreateCheckoutSession));
app.post("/api/getMyCourseAccess", verifyAuth, wrapCallable(handleGetMyCourseAccess));
app.post("/api/requestProductInfo", wrapCallable(handleRequestProductInfo, false));
app.post("/api/sendWhatsappNotification", verifyAuth, wrapCallable(handleSendWhatsappNotification));

// Stripe webhook (raw body)
app.post(stripeWebhookPath, async (req: Request, res: Response) => {
  try {
    await handleStripeWebhook(req, res);
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).send("Webhook handler failed.");
  }
});

// Health check
app.get("/", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "usa-app-backend" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
