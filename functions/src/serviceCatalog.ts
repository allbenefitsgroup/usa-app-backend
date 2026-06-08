import { Request, Response } from "express";
import { ddb, SERVICE_CATALOG_TABLE } from "./dynamodb";
import { GetCommand, PutCommand, ScanCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { generateUid } from "./auth";

export async function handleListServiceCatalog(req: Request, res: Response) {
  try {
    // Público: cualquiera puede ver los servicios disponibles
    let lastEvaluatedKey: Record<string, any> | undefined = undefined;
    const items: any[] = [];

    do {
      const result: any = await ddb.send(
        new ScanCommand({
          TableName: SERVICE_CATALOG_TABLE,
          FilterExpression: "active = :active",
          ExpressionAttributeValues: { ":active": true },
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );

      if (result.Items) {
        items.push(...result.Items);
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    items.sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));

    res.json({
      ok: true,
      catalog: items.map((item: any) => ({
        id: item.id,
        name: item.name,
        type: item.type || null,
        description: item.description || null,
        active: !!item.active,
      })),
    });
  } catch (error: any) {
    console.error("ListServiceCatalog error:", error);
    res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
  }
}

export async function handleListAllCatalogItems(req: Request, res: Response) {
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
    const items: any[] = [];

    do {
      const result: any = await ddb.send(
        new ScanCommand({
          TableName: SERVICE_CATALOG_TABLE,
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );

      if (result.Items) {
        items.push(...result.Items);
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    items.sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));

    res.json({
      ok: true,
      catalog: items.map((item: any) => ({
        id: item.id,
        name: item.name,
        type: item.type || null,
        description: item.description || null,
        active: !!item.active,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
      total: items.length,
    });
  } catch (error: any) {
    console.error("ListAllCatalogItems error:", error);
    res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
  }
}

export async function handleCreateCatalogItem(req: Request, res: Response) {
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

    if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
      res.status(400).json({ error: { message: "name is required.", status: "INVALID_ARGUMENT" } });
      return;
    }

    const id = generateUid();
    const now = new Date().toISOString();

    const item = {
      id,
      name: body.name.trim(),
      type: body.type ? body.type.trim() : null,
      description: body.description ? body.description.trim() : null,
      active: body.active === false ? false : true,
      createdAt: now,
      updatedAt: now,
    };

    await ddb.send(
      new PutCommand({
        TableName: SERVICE_CATALOG_TABLE,
        Item: item,
      })
    );

    res.status(201).json({ ok: true, id, item });
  } catch (error: any) {
    console.error("CreateCatalogItem error:", error);
    res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
  }
}

export async function handleUpdateCatalogItem(req: Request, res: Response) {
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

    const getResult = await ddb.send(
      new GetCommand({
        TableName: SERVICE_CATALOG_TABLE,
        Key: { id },
      })
    );

    if (!getResult.Item) {
      res.status(404).json({ error: { message: "Catalog item not found.", status: "NOT_FOUND" } });
      return;
    }

    const body = req.body;
    const updateExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    if (body.name !== undefined) {
      updateExpressions.push("#n = :n");
      expressionAttributeNames["#n"] = "name";
      expressionAttributeValues[":n"] = body.name.trim();
    }
    if (body.type !== undefined) {
      updateExpressions.push("#t = :t");
      expressionAttributeNames["#t"] = "type";
      expressionAttributeValues[":t"] = body.type ? body.type.trim() : null;
    }
    if (body.description !== undefined) {
      updateExpressions.push("#d = :d");
      expressionAttributeNames["#d"] = "description";
      expressionAttributeValues[":d"] = body.description ? body.description.trim() : null;
    }
    if (body.active !== undefined) {
      updateExpressions.push("#a = :a");
      expressionAttributeNames["#a"] = "active";
      expressionAttributeValues[":a"] = !!body.active;
    }

    if (updateExpressions.length === 0) {
      res.json({ ok: true, id, message: "No changes to update." });
      return;
    }

    updateExpressions.push("updatedAt = :now");
    expressionAttributeValues[":now"] = new Date().toISOString();

    await ddb.send(
      new UpdateCommand({
        TableName: SERVICE_CATALOG_TABLE,
        Key: { id },
        UpdateExpression: "set " + updateExpressions.join(", "),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      })
    );

    res.json({ ok: true, id });
  } catch (error: any) {
    console.error("UpdateCatalogItem error:", error);
    res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
  }
}

export async function handleDeleteCatalogItem(req: Request, res: Response) {
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

    const getResult = await ddb.send(
      new GetCommand({
        TableName: SERVICE_CATALOG_TABLE,
        Key: { id },
      })
    );

    if (!getResult.Item) {
      res.status(404).json({ error: { message: "Catalog item not found.", status: "NOT_FOUND" } });
      return;
    }

    await ddb.send(
      new DeleteCommand({
        TableName: SERVICE_CATALOG_TABLE,
        Key: { id },
      })
    );

    res.json({ ok: true, id });
  } catch (error: any) {
    console.error("DeleteCatalogItem error:", error);
    res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
  }
}
