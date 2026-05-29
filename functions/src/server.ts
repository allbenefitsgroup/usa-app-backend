import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import path from "path";
import {
  handleSyncUserProfile,
  handleCreateCheckoutSession,
  handleGetMyCourseAccess,
  handleStripeWebhook,
  handleRequestProductInfo,
  handleSendWhatsappNotification,
  ApiRequest,
} from "./index";
import {
  requireAuth,
  optionalAuth,
  handleRegister,
  handleLogin,
  handleGetMe,
} from "./auth";

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

// Helper to wrap callable handlers for Express
function wrapHandler<T>(handler: (req: ApiRequest<T>) => Promise<any>, requiresAuth = true) {
  return async (req: Request, res: Response) => {
    try {
      const authContext = (req as any).authContext;
      if (requiresAuth && !authContext) {
        return res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
      }

      const request: ApiRequest<T> = {
        data: req.body.data || req.body,
        auth: authContext || undefined,
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

// Auth endpoints
app.post("/api/auth/register", (req, res, next) => { handleRegister(req, res).catch(next); });
app.post("/api/auth/login", (req, res, next) => { handleLogin(req, res).catch(next); });
app.get("/api/auth/me", requireAuth, (req, res, next) => { handleGetMe(req, res).catch(next); });

// Protected business endpoints
app.post("/api/syncUserProfile", requireAuth, wrapHandler(handleSyncUserProfile));
app.post("/api/createCheckoutSession", requireAuth, wrapHandler(handleCreateCheckoutSession));
app.post("/api/getMyCourseAccess", requireAuth, wrapHandler(handleGetMyCourseAccess));
app.post("/api/requestProductInfo", optionalAuth, wrapHandler(handleRequestProductInfo, false));
app.post("/api/sendWhatsappNotification", requireAuth, wrapHandler(handleSendWhatsappNotification));

// Stripe webhook (raw body)
app.post(stripeWebhookPath, async (req: Request, res: Response) => {
  try {
    await handleStripeWebhook(req, res);
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).send("Webhook handler failed.");
  }
});

// Swagger docs
const swaggerDocument = YAML.load(path.join(__dirname, "swagger.yaml"));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Health check
app.get("/", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "usa-app-backend" });
});

const PORT = process.env.PORT || 3000;
if (!process.env.FUNCTIONS_EMULATOR && !process.env.K_SERVICE) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;
