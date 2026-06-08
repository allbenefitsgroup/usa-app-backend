import { Request, Response } from "express";
import { ddb, SERVICES_TABLE } from "./dynamodb";
import { GetCommand, PutCommand, ScanCommand, UpdateCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { generateUid } from "./auth";
import { ClientService } from "./models";

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
        currency: s.currency || null,
        notes: s.notes || null,
        beneficiaryName: s.beneficiaryName || null,
        beneficiaryPhone: s.beneficiaryPhone || null,
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

    const allowedRoles = ["seller", "admin"];
    if (!allowedRoles.includes(authContext.role)) {
      res.status(403).json({ error: { message: "Forbidden: admin access required.", status: "PERMISSION_DENIED" } });
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

    const validStatuses = ["active", "expired", "cancelled", "pending"];
    const status = body.status || "active";
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
      expiryDate: body.expiryDate || null,
      status,
      coverageAmount: typeof body.coverageAmount === "number" ? body.coverageAmount : null,
      premiumAmount: typeof body.premiumAmount === "number" ? body.premiumAmount : null,
      currency: body.currency ? body.currency.trim().toUpperCase() : null,
      notes: body.notes ? body.notes.trim() : null,
      beneficiaryName: body.beneficiaryName ? body.beneficiaryName.trim() : null,
      beneficiaryPhone: body.beneficiaryPhone ? body.beneficiaryPhone.trim() : null,
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

    const body = req.body;
    const updateExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

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
    };

    for (const [key, attrName] of Object.entries(fields)) {
      if (body[key] !== undefined) {
        const safeKey = key.replace(/[^a-zA-Z0-9]/g, "");
        updateExpressions.push(`#${safeKey} = :${safeKey}`);
        expressionAttributeNames[`#${safeKey}`] = attrName;
        let value = body[key];
        if (typeof value === "string" && (key === "userEmail" || key === "currency")) {
          value = value.toLowerCase().trim();
        } else if (typeof value === "string") {
          value = value.trim();
        }
        expressionAttributeValues[`:${safeKey}`] = value;
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
