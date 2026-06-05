import 'dotenv/config';
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
  handleGetRecommendations,
  handleListRecommendations,
  handleCreateRecommendation,
  handleUpdateRecommendation,
  handleDeleteRecommendation,
  handleReorderRecommendations,
  ApiRequest,
} from "./index";
import {
  requireAuth,
  optionalAuth,
  handleRegister,
  handleLogin,
  handleAdminLogin,
  handleGetMe,
  handleLogout,
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

// Force UTF-8 charset on JSON responses to avoid encoding issues
app.use((_req: Request, res: Response, next: NextFunction) => {
  const originalJson = res.json.bind(res);
  res.json = function (body: any) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return originalJson(body);
  };
  next();
});

// Admin middleware: requires auth and role must be seller or admin
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const authContext = (req as any).authContext;
  if (!authContext) {
    return res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
  }
  const allowedRoles = ["seller", "admin"];
  if (!allowedRoles.includes(authContext.role)) {
    return res.status(403).json({ error: { message: "Forbidden: admin access required.", status: "PERMISSION_DENIED" } });
  }
  next();
}

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
app.post("/api/auth/admin/login", (req, res, next) => { handleAdminLogin(req, res).catch(next); });
app.post("/api/auth/logout", handleLogout);
app.get("/api/auth/me", requireAuth, (req, res, next) => { handleGetMe(req, res).catch(next); });

// Protected business endpoints
app.post("/api/syncUserProfile", requireAuth, wrapHandler(handleSyncUserProfile));
app.post("/api/createCheckoutSession", requireAuth, wrapHandler(handleCreateCheckoutSession));
app.post("/api/getMyCourseAccess", requireAuth, wrapHandler(handleGetMyCourseAccess));
app.post("/api/requestProductInfo", optionalAuth, wrapHandler(handleRequestProductInfo, false));
app.post("/api/sendWhatsappNotification", requireAuth, wrapHandler(handleSendWhatsappNotification));

// Public recommendations (rotating tips)
app.get("/api/recommendations", async (_req: Request, res: Response) => {
  try {
    const result = await handleGetRecommendations();
    res.json({ result });
  } catch (error: any) {
    console.error("Recommendations error:", error);
    res.status(500).json({
      error: {
        message: error.message || "Failed to load recommendations",
        status: "INTERNAL",
      },
    });
  }
});

// Admin CRUD for recommendations (only sellers)
app.get("/api/admin/recommendations", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await handleListRecommendations();
    res.json({ result });
  } catch (error: any) {
    console.error("List recommendations error:", error);
    res.status(500).json({ error: { message: error.message || "Internal error", status: "INTERNAL" } });
  }
});
app.post("/api/admin/recommendations", wrapHandler(handleCreateRecommendation, false));
app.put("/api/admin/recommendations/:id", requireAuth, requireAdmin, wrapHandler(handleUpdateRecommendation));
app.delete("/api/admin/recommendations/:id", requireAuth, requireAdmin, wrapHandler(handleDeleteRecommendation));
app.put("/api/admin/recommendations/reorder", requireAuth, requireAdmin, wrapHandler(handleReorderRecommendations));

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
const swaggerPath = path.join(__dirname, "..", "src", "swagger.yaml");
const swaggerDocument = YAML.load(swaggerPath);
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Health check
app.get("/", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "usa-app-backend" });
});

// Global error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Express error:", err);
  if (!res.headersSent) {
    res.status(err.status || 500).json({
      error: {
        message: err.message || "Internal server error",
        status: err.status || "INTERNAL",
      },
    });
  }
});

const PORT = process.env.PORT || 3000;
if (!process.env.FUNCTIONS_EMULATOR && !process.env.K_SERVICE) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;
