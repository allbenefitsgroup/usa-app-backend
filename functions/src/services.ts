import { Request, Response } from "express";
import { ddb, SERVICES_TABLE } from "./dynamodb";
import { GetCommand, PutCommand, ScanCommand, UpdateCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { generateUid } from "./auth";
import { ClientService } from "./models";
import { uploadToS3 } from "./s3Upload";

export async function handleGetMyServices(req: Request, res: Response) {
  try {
    const authContext = (req as any).authContext;
    if (!authContext) {
      res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
      return;
    }

    const userId = authContext.uid;
    const userEmail = authContext.email;

    // Buscar servicios por userId
    const result = await ddb.send(
      new ScanCommand({
        TableName: SERVICES_TABLE,
        FilterExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId },
      })
    );

    // Si no hay por uid, intentar por email (para datos legacy importados)
    let services = result.Items || [];
    if (services.length === 0 && userEmail) {
      const emailResult = await ddb.send(
        new ScanCommand({
          TableName: SERVICES_TABLE,
          FilterExpression: "userEmail = :email",
          ExpressionAttributeValues: { ":email": userEmail.toLowerCase().trim() },
        })
      );
      services = emailResult.Items || [];
    }

    // Ordenar por fecha de contratación descendente
    services.sort((a: any, b: any) => {
      const dateA = a.contractDate ? new Date(a.contractDate).getTime() : 0;
      const dateB = b.contractDate ? new Date(b.contractDate).getTime() : 0;
      return dateB - dateA;
    });

    res.json({
      ok: true,
      services: services.map((s: any) => ({
        id: s.id,
        serviceName: s.serviceName,
        serviceType: s.serviceType || null,
        policyNumber: s.policyNumber || null,
        contractDate: s.contractDate || null,
        expiryDate: s.expiryDate || null,
        status: s.status || "active",
        coverageAmount: s.coverageAmount || null,
        premiumAmount: s.premiumAmount || null,
        monthpay: s.monthpay || null,
        companyName: s.companyName || null,
        currency: s.currency || null,
        notes: s.notes || null,
        beneficiaryName: s.beneficiaryName || null,
        beneficiaryPhone: s.beneficiaryPhone || null,
        serviceImages: s.serviceImages || [],
        serviceDocuments: s.serviceDocuments || [],
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    });
  } catch (error: any) {
    console.error("GetMyServices error:", error);
    res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
  }
}

export async function handleCreateService(req: Request, res: Response) {
  try {
    const authContext = (req as any).authContext;
    if (!authContext) {
      res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
      return;
    }

    const allowedRoles = ["seller", "admin", "customer", "client"];
    if (!allowedRoles.includes(authContext.role)) {
      res.status(403).json({ error: { message: "Forbidden: access denied.", status: "PERMISSION_DENIED" } });
      return;
    }

    const body = req.body;

    if (!body.serviceName || typeof body.serviceName !== "string") {
      res.status(400).json({ error: { message: "serviceName is required.", status: "INVALID_ARGUMENT" } });
      return;
    }
    if (!body.userId || typeof body.userId !== "string") {
      res.status(400).json({ error: { message: "userId is required.", status: "INVALID_ARGUMENT" } });
      return;
    }
    if (!body.contractDate || typeof body.contractDate !== "string") {
      res.status(400).json({ error: { message: "contractDate is required.", status: "INVALID_ARGUMENT" } });
      return;
    }

    if (body.monthpay !== undefined && body.monthpay !== null) {
      const monthpay = typeof body.monthpay === "string" ? parseFloat(body.monthpay) : body.monthpay;
      if (typeof monthpay !== "number" || isNaN(monthpay) || monthpay < 0) {
        res.status(400).json({ error: { message: "monthpay must be a non-negative number.", status: "INVALID_ARGUMENT" } });
        return;
      }
    }

    let serviceImages: string[] = [];
    if (body.serviceImages !== undefined) {
      if (typeof body.serviceImages === "string") {
        try { serviceImages = JSON.parse(body.serviceImages); } catch { serviceImages = [body.serviceImages]; }
      } else if (Array.isArray(body.serviceImages)) {
        serviceImages = body.serviceImages.map((s: any) => String(s).trim()).filter(Boolean);
      }
      if (!Array.isArray(serviceImages)) {
        res.status(400).json({ error: { message: "serviceImages must be an array.", status: "INVALID_ARGUMENT" } });
        return;
      }
    }

    let serviceDocuments: string[] = [];
    if (body.serviceDocuments !== undefined) {
      if (typeof body.serviceDocuments === "string") {
        try { serviceDocuments = JSON.parse(body.serviceDocuments); } catch { serviceDocuments = [body.serviceDocuments]; }
      } else if (Array.isArray(body.serviceDocuments)) {
        serviceDocuments = body.serviceDocuments.map((s: any) => String(s).trim()).filter(Boolean);
      }
      if (!Array.isArray(serviceDocuments)) {
        res.status(400).json({ error: { message: "serviceDocuments must be an array.", status: "INVALID_ARGUMENT" } });
        return;
      }
    }

    const files = req.files as Express.Multer.File[] | undefined;
    if (files && files.length > 0) {
      const imageExtensions = ["jpg", "jpeg", "png", "gif", "webp", "svg"];
      for (const file of files) {
        const ext = file.originalname.split(".").pop()?.toLowerCase() || "";
        const isImage = imageExtensions.includes(ext) || file.mimetype.startsWith("image/");
        const prefix = isImage ? "services/images/" : "services/documents/";
        const url = await uploadToS3(file.buffer, file.originalname, file.mimetype, prefix);
        if (isImage) {
          serviceImages.push(url);
        } else {
          serviceDocuments.push(url);
        }
      }
    }

    const validStatuses = ["active", "expired", "cancelled", "pending"];
    const statusMap: Record<string, string> = {
      "Activo": "active",
      "Vencido": "expired",
      "Cancelado": "cancelled",
      "Pendiente": "pending",
    };
    const rawStatus = body.status || "active";
    const status = statusMap[rawStatus] || rawStatus;
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: { message: `status must be one of: ${validStatuses.join(", ")}.`, status: "INVALID_ARGUMENT" } });
      return;
    }

    const id = generateUid();
    const now = new Date().toISOString();

    const service: Record<string, any> = {
      id,
      userId: body.userId.trim(),
      userEmail: body.userEmail ? body.userEmail.toLowerCase().trim() : null,
      serviceName: body.serviceName.trim(),
      serviceType: body.serviceType ? body.serviceType.trim() : null,
      policyNumber: body.policyNumber ? body.policyNumber.trim() : null,
      contractDate: body.contractDate,
      expiryDate: body.expiryDate || body.expirationDate || null,
      status,
      coverageAmount: body.coverageAmount !== undefined && body.coverageAmount !== "" ? (typeof body.coverageAmount === "number" ? body.coverageAmount : parseFloat(body.coverageAmount)) : null,
      premiumAmount: body.premiumAmount !== undefined && body.premiumAmount !== "" ? (typeof body.premiumAmount === "number" ? body.premiumAmount : parseFloat(body.premiumAmount)) : null,
      currency: body.currency ? body.currency.trim().toUpperCase() : null,
      notes: body.notes || body.details || null,
      beneficiaryName: body.beneficiaryName ? body.beneficiaryName.trim() : null,
      beneficiaryPhone: body.beneficiaryPhone ? body.beneficiaryPhone.trim() : null,
      serviceImages: serviceImages.length > 0 ? serviceImages : null,
      serviceDocuments: serviceDocuments.length > 0 ? serviceDocuments : null,
      monthpay: body.monthpay !== undefined && body.monthpay !== null && body.monthpay !== "" ? (typeof body.monthpay === "number" ? body.monthpay : parseFloat(body.monthpay)) : null,
      companyName: body.companyName ? body.companyName.trim() : null,
      createdAt: now,
      updatedAt: now,
    };

    await ddb.send(
      new PutCommand({
        TableName: SERVICES_TABLE,
        Item: service,
      })
    );

    res.status(201).json({ ok: true, id, service });
  } catch (error: any) {
    console.error("CreateService error:", error);
    res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
  }
}

export async function handleListAllServices(req: Request, res: Response) {
  try {
    const authContext = (req as any).authContext;
    if (!authContext) {
      res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
      return;
    }

    const allowedRoles = ["seller", "admin"];
    if (!allowedRoles.includes(authContext.role)) {
      res.status(403).json({ error: { message: "Forbidden: admin access required.", status: "PERMISSION_DENIED" } });
      return;
    }

    let lastEvaluatedKey: Record<string, any> | undefined = undefined;
    const allServices: any[] = [];

    do {
      const result: any = await ddb.send(
        new ScanCommand({
          TableName: SERVICES_TABLE,
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );

      if (result.Items) {
        allServices.push(...result.Items);
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    // Ordenar por fecha de actualización descendente
    allServices.sort((a: any, b: any) => {
      const dateA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const dateB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return dateB - dateA;
    });

    res.json({
      ok: true,
      services: allServices,
      total: allServices.length,
    });
  } catch (error: any) {
    console.error("ListAllServices error:", error);
    res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
  }
}

export async function handleUpdateService(req: Request, res: Response) {
  try {
    const authContext = (req as any).authContext;
    if (!authContext) {
      res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
      return;
    }

    const allowedRoles = ["seller", "admin", "customer", "client"];
    if (!allowedRoles.includes(authContext.role)) {
      res.status(403).json({ error: { message: "Forbidden: access denied.", status: "PERMISSION_DENIED" } });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: { message: "id is required.", status: "INVALID_ARGUMENT" } });
      return;
    }

    // Verificar que existe
    const getResult = await ddb.send(
      new GetCommand({
        TableName: SERVICES_TABLE,
        Key: { id },
      })
    );

    if (!getResult.Item) {
      res.status(404).json({ error: { message: "Service not found.", status: "NOT_FOUND" } });
      return;
    }

    const body = req.body;
    const updateExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    const statusMap: Record<string, string> = {
      "Activo": "active",
      "Vencido": "expired",
      "Cancelado": "cancelled",
      "Pendiente": "pending",
    };

    const fields: Record<string, string> = {
      userId: "userId",
      userEmail: "userEmail",
      serviceName: "serviceName",
      serviceType: "serviceType",
      policyNumber: "policyNumber",
      contractDate: "contractDate",
      expiryDate: "expiryDate",
      status: "status",
      coverageAmount: "coverageAmount",
      premiumAmount: "premiumAmount",
      currency: "currency",
      notes: "notes",
      beneficiaryName: "beneficiaryName",
      beneficiaryPhone: "beneficiaryPhone",
      monthpay: "monthpay",
      companyName: "companyName",
    };

    // Alias mappings
    const aliasMap: Record<string, string> = {
      expirationDate: "expiryDate",
      details: "notes",
    };

    for (const [key, attrName] of Object.entries(fields)) {
      let value = body[key];
      // Check for alias if primary key is missing
      if (value === undefined && aliasMap[key]) {
        value = body[aliasMap[key]];
      }
      if (value !== undefined) {
        const safeKey = key.replace(/[^a-zA-Z0-9]/g, "");
        updateExpressions.push(`#${safeKey} = :${safeKey}`);
        expressionAttributeNames[`#${safeKey}`] = attrName;
        if (typeof value === "string" && (key === "userEmail" || key === "currency")) {
          value = value.toLowerCase().trim();
        } else if (typeof value === "string") {
          value = value.trim();
        }
        if (key === "status" && typeof value === "string") {
          value = statusMap[value] || value;
        }
        expressionAttributeValues[`:${safeKey}`] = value;
      }
    }

    if (body.monthpay !== undefined) {
      const monthpay = typeof body.monthpay === "string" ? parseFloat(body.monthpay) : body.monthpay;
      if (typeof monthpay !== "number" || isNaN(monthpay) || monthpay < 0) {
        res.status(400).json({ error: { message: "monthpay must be a non-negative number.", status: "INVALID_ARGUMENT" } });
        return;
      }
      updateExpressions.push("#monthpay = :monthpay");
      expressionAttributeNames["#monthpay"] = "monthpay";
      expressionAttributeValues[":monthpay"] = monthpay;
    }

    let serviceImages: string[] | undefined;
    if (body.serviceImages !== undefined) {
      if (typeof body.serviceImages === "string") {
        try { serviceImages = JSON.parse(body.serviceImages); } catch { serviceImages = [body.serviceImages]; }
      } else if (Array.isArray(body.serviceImages)) {
        serviceImages = body.serviceImages.map((s: any) => String(s).trim()).filter(Boolean);
      }
      if (!Array.isArray(serviceImages)) {
        res.status(400).json({ error: { message: "serviceImages must be an array.", status: "INVALID_ARGUMENT" } });
        return;
      }
      updateExpressions.push("#serviceImages = :serviceImages");
      expressionAttributeNames["#serviceImages"] = "serviceImages";
      expressionAttributeValues[":serviceImages"] = serviceImages;
    }

    let serviceDocuments: string[] | undefined;
    if (body.serviceDocuments !== undefined) {
      if (typeof body.serviceDocuments === "string") {
        try { serviceDocuments = JSON.parse(body.serviceDocuments); } catch { serviceDocuments = [body.serviceDocuments]; }
      } else if (Array.isArray(body.serviceDocuments)) {
        serviceDocuments = body.serviceDocuments.map((s: any) => String(s).trim()).filter(Boolean);
      }
      if (!Array.isArray(serviceDocuments)) {
        res.status(400).json({ error: { message: "serviceDocuments must be an array.", status: "INVALID_ARGUMENT" } });
        return;
      }
      updateExpressions.push("#serviceDocuments = :serviceDocuments");
      expressionAttributeNames["#serviceDocuments"] = "serviceDocuments";
      expressionAttributeValues[":serviceDocuments"] = serviceDocuments;
    }

    const files = req.files as Express.Multer.File[] | undefined;
    if (files && files.length > 0) {
      const imageExtensions = ["jpg", "jpeg", "png", "gif", "webp", "svg"];
      let newImages: string[] = serviceImages || [];
      let newDocs: string[] = serviceDocuments || [];
      for (const file of files) {
        const ext = file.originalname.split(".").pop()?.toLowerCase() || "";
        const isImage = imageExtensions.includes(ext) || file.mimetype.startsWith("image/");
        const prefix = isImage ? "services/images/" : "services/documents/";
        const url = await uploadToS3(file.buffer, file.originalname, file.mimetype, prefix);
        if (isImage) {
          newImages.push(url);
        } else {
          newDocs.push(url);
        }
      }
      if (newImages.length > 0) {
        updateExpressions.push("#serviceImages = :serviceImages");
        expressionAttributeNames["#serviceImages"] = "serviceImages";
        expressionAttributeValues[":serviceImages"] = newImages;
      }
      if (newDocs.length > 0) {
        updateExpressions.push("#serviceDocuments = :serviceDocuments");
        expressionAttributeNames["#serviceDocuments"] = "serviceDocuments";
        expressionAttributeValues[":serviceDocuments"] = newDocs;
      }
    }

    if (updateExpressions.length === 0) {
      res.json({ ok: true, id, message: "No changes to update." });
      return;
    }

    updateExpressions.push("updatedAt = :now");
    expressionAttributeValues[":now"] = new Date().toISOString();

    await ddb.send(
      new UpdateCommand({
        TableName: SERVICES_TABLE,
        Key: { id },
        UpdateExpression: "set " + updateExpressions.join(", "),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      })
    );

    res.json({ ok: true, id });
  } catch (error: any) {
    console.error("UpdateService error:", error);
    res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
  }
}

export async function handleDeleteService(req: Request, res: Response) {
  try {
    const authContext = (req as any).authContext;
    if (!authContext) {
      res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
      return;
    }

    const allowedRoles = ["seller", "admin"];
    if (!allowedRoles.includes(authContext.role)) {
      res.status(403).json({ error: { message: "Forbidden: admin access required.", status: "PERMISSION_DENIED" } });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: { message: "id is required.", status: "INVALID_ARGUMENT" } });
      return;
    }

    // Verificar que existe
    const getResult = await ddb.send(
      new GetCommand({
        TableName: SERVICES_TABLE,
        Key: { id },
      })
    );

    if (!getResult.Item) {
      res.status(404).json({ error: { message: "Service not found.", status: "NOT_FOUND" } });
      return;
    }

    await ddb.send(
      new DeleteCommand({
        TableName: SERVICES_TABLE,
        Key: { id },
      })
    );

    res.json({ ok: true, id });
  } catch (error: any) {
    console.error("DeleteService error:", error);
    res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
  }
}

export async function handleBulkImportServices(req: Request, res: Response) {
  try {
    const authContext = (req as any).authContext;
    if (!authContext) {
      res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
      return;
    }

    const allowedRoles = ["seller", "admin"];
    if (!allowedRoles.includes(authContext.role)) {
      res.status(403).json({ error: { message: "Forbidden: admin access required.", status: "PERMISSION_DENIED" } });
      return;
    }

    const body = req.body;
    const services = Array.isArray(body.services) ? body.services : [];

    if (services.length === 0) {
      res.status(400).json({ error: { message: "services array is required.", status: "INVALID_ARGUMENT" } });
      return;
    }

    const validStatuses = ["active", "expired", "cancelled", "pending"];
    const now = new Date().toISOString();
    const imported: string[] = [];
    const failed: Array<{ index: number; reason: string }> = [];

    for (let i = 0; i < services.length; i++) {
      const s = services[i];
      try {
        if (!s.serviceName || !s.userId || !s.contractDate) {
          failed.push({ index: i, reason: "Missing required fields: serviceName, userId, contractDate" });
          continue;
        }

        const status = s.status || "active";
        if (!validStatuses.includes(status)) {
          failed.push({ index: i, reason: `Invalid status: ${status}` });
          continue;
        }

        const id = generateUid();
        const service: Record<string, any> = {
          id,
          userId: String(s.userId).trim(),
          userEmail: s.userEmail ? String(s.userEmail).toLowerCase().trim() : null,
          serviceName: String(s.serviceName).trim(),
          serviceType: s.serviceType ? String(s.serviceType).trim() : null,
          policyNumber: s.policyNumber ? String(s.policyNumber).trim() : null,
          contractDate: String(s.contractDate),
          expiryDate: s.expiryDate ? String(s.expiryDate) : null,
          status,
          coverageAmount: typeof s.coverageAmount === "number" ? s.coverageAmount : null,
          premiumAmount: typeof s.premiumAmount === "number" ? s.premiumAmount : null,
          currency: s.currency ? String(s.currency).trim().toUpperCase() : null,
          notes: s.notes ? String(s.notes).trim() : null,
          beneficiaryName: s.beneficiaryName ? String(s.beneficiaryName).trim() : null,
          beneficiaryPhone: s.beneficiaryPhone ? String(s.beneficiaryPhone).trim() : null,
          createdAt: now,
          updatedAt: now,
        };

        await ddb.send(
          new PutCommand({
            TableName: SERVICES_TABLE,
            Item: service,
          })
        );

        imported.push(id);
      } catch (err: any) {
        failed.push({ index: i, reason: err.message || "Unknown error" });
      }
    }

    res.status(201).json({
      ok: true,
      imported: imported.length,
      failed: failed.length,
      ids: imported,
      errors: failed,
    });
  } catch (error: any) {
    console.error("BulkImportServices error:", error);
    res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
  }
}
