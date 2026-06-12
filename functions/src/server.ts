import 'dotenv/config';
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import path from "path";
import multer from "multer";
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
  handleListUsers,
  handleDeleteUser,
  handleCreateUser,
  handleGetUser,
  handleGetUserPublic,
  handleUpdateUserProfile,
} from "./auth";
import { uploadImageToS3 } from "./s3Upload";
import {
  handleGetMyServices,
  handleCreateService,
  handleListAllServices,
  handleUpdateService,
  handleDeleteService,
  handleBulkImportServices,
} from "./services";
import { handleGenerateSellerQR, handleGetPublicSellerProfile } from "./qr";
import {
  handleListServiceCatalog,
  handleListAllCatalogItems,
  handleCreateCatalogItem,
  handleUpdateCatalogItem,
  handleDeleteCatalogItem,
} from "./serviceCatalog";

const app = express();

// Stripe webhook needs raw body before any JSON parser
const stripeWebhookPath = "/stripeWebhook";

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

// Body parsers: skip JSON parser for multipart/form-data so multer can handle files
app.use((req: Request, res: Response, next: NextFunction) => {
  const contentType = req.headers["content-type"] || "";
  if (req.path === stripeWebhookPath) {
    express.raw({ type: "application/json" })(req, res, next);
  } else if (contentType.includes("multipart/form-data")) {
    next();
  } else {
    express.json({ limit: "1mb" })(req, res, next);
  }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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
        data: { ...req.body.data, ...req.body, ...req.params },
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

// Service catalog (public list of available services)
app.get("/api/service-catalog", handleListServiceCatalog);

// Admin service catalog CRUD
app.get("/api/admin/service-catalog", requireAuth, handleListAllCatalogItems);
app.post("/api/admin/service-catalog", requireAuth, handleCreateCatalogItem);
app.put("/api/admin/service-catalog/:id", requireAuth, handleUpdateCatalogItem);
app.delete("/api/admin/service-catalog/:id", requireAuth, handleDeleteCatalogItem);

// Admin users list (with optional role filter)
app.get("/api/admin/users", requireAuth, handleListUsers);
app.get("/api/admin/users/:id", requireAuth, handleGetUser);
app.post("/api/admin/users", requireAuth, handleCreateUser);
app.delete("/api/admin/users/:id", requireAuth, handleDeleteUser);

// Public user endpoint (for any authenticated user)
app.get("/api/users/:id", requireAuth, handleGetUserPublic);

// Update user profile (seller data: name, title, description, location, rating, specialties, phone, email)
app.put("/api/users/:id/profile", requireAuth, handleUpdateUserProfile);

// QR endpoint for seller data (operator shows QR to client)
// Public: no auth required, so anyone can request/generate a QR code
app.get("/api/sellers/:id/qr", handleGenerateSellerQR);

// Public seller profile endpoint (for scanning the QR code without auth)
app.get("/api/public/sellers/:id", handleGetPublicSellerProfile);

// Client services endpoints
app.get("/api/my-services", requireAuth, handleGetMyServices);
app.post("/api/admin/services", requireAuth, handleCreateService);
app.get("/api/admin/services", requireAuth, handleListAllServices);
app.put("/api/admin/services/:id", requireAuth, handleUpdateService);
app.delete("/api/admin/services/:id", requireAuth, handleDeleteService);
app.post("/api/admin/services/bulk", requireAuth, handleBulkImportServices);

// Alias for frontend compatibility
app.post("/api/admin/client-services", requireAuth, handleCreateService);
app.get("/api/admin/client-services", requireAuth, handleListAllServices);
app.put("/api/admin/client-services/:id", requireAuth, handleUpdateService);
app.delete("/api/admin/client-services/:id", requireAuth, handleDeleteService);

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

// Helper to handle image from multipart or base64 JSON
async function resolveImageUrl(req: Request): Promise<string | null> {
  // 1. If multer uploaded a file
  if ((req as any).file) {
    const f = (req as any).file;
    return uploadImageToS3(f.buffer, f.originalname, f.mimetype);
  }

  // 2. If JSON body contains a base64 data URI
  const imageUrl = req.body?.imageUrl;
  if (typeof imageUrl === "string" && imageUrl.startsWith("data:")) {
    const matches = imageUrl.match(/^data:(.+);base64,(.+)$/);
    if (matches) {
      const mimeType = matches[1];
      const base64Data = matches[2];
      const buffer = Buffer.from(base64Data, "base64");
      const ext = mimeType.split("/").pop() || "png";
      return uploadImageToS3(buffer, `image.${ext}`, mimeType);
    }
  }

  // 3. Otherwise return the provided URL or null
  return imageUrl || null;
}

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
app.post("/api/admin/recommendations", upload.single("image"), async (req: Request, res: Response) => {
  try {
    const imageUrl = await resolveImageUrl(req);

    const body = req.body || {};
    const request: ApiRequest<any> = {
      data: {
        title: body.title,
        subtitle: body.subtitle,
        type: body.type,
        externalUrl: body.externalUrl,
        imageUrl: imageUrl || body.imageUrl || null,
        color: body.color,
        icon: body.icon,
        ctaLabel: body.ctaLabel,
        ctaLink: body.ctaLink,
        active: body.active === "true" || body.active === true ? true : false,
      },
      auth: undefined,
      rawRequest: req,
    };

    const result = await handleCreateRecommendation(request);
    res.json({ result });
  } catch (error: any) {
    console.error("Create recommendation error:", error);
    if (error.code && error.message) {
      res.json({ error: { message: error.message, status: error.code } });
    } else {
      res.status(500).json({ error: { message: error.message || "Internal error", status: "INTERNAL" } });
    }
  }
});
app.put("/api/admin/recommendations/:id", requireAuth, requireAdmin, upload.single("image"), async (req: Request, res: Response) => {
  try {
    const imageUrl = await resolveImageUrl(req);

    const body = req.body || {};
    const request: ApiRequest<any> = {
      data: {
        id: req.params.id,
        title: body.title,
        subtitle: body.subtitle,
        type: body.type,
        externalUrl: body.externalUrl,
        imageUrl: imageUrl || body.imageUrl || undefined,
        color: body.color,
        icon: body.icon,
        ctaLabel: body.ctaLabel,
        ctaLink: body.ctaLink,
        active: body.active === "true" || body.active === true ? true : body.active === "false" || body.active === false ? false : undefined,
      },
      auth: (req as any).authContext || undefined,
      rawRequest: req,
    };

    const result = await handleUpdateRecommendation(request);
    res.json({ result });
  } catch (error: any) {
    console.error("Update recommendation error:", error);
    if (error.code && error.message) {
      res.json({ error: { message: error.message, status: error.code } });
    } else {
      res.status(500).json({ error: { message: error.message || "Internal error", status: "INTERNAL" } });
    }
  }
});
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
const swaggerPath = path.join(process.cwd(), "lib", "swagger.yaml");
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
