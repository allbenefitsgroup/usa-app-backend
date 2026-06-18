import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-2";

const client = new DynamoDBClient({ region: REGION });
export const ddb = DynamoDBDocumentClient.from(client);

export const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "usa-users-v2";
export const EMAIL_INDEX = process.env.DYNAMODB_EMAIL_INDEX || "EmailIndex";
export const LEADS_TABLE = process.env.DYNAMODB_LEADS_TABLE || "usa-leads";
export const REVOKED_TOKENS_TABLE = process.env.DYNAMODB_REVOKED_TOKENS_TABLE || "usa-revoked-tokens";
export const RECOMMENDATIONS_TABLE = process.env.DYNAMODB_RECOMMENDATIONS_TABLE || "usa-recommendations";
export const SERVICES_TABLE = process.env.DYNAMODB_SERVICES_TABLE || "usa-services";
export const SERVICE_CATALOG_TABLE = process.env.DYNAMODB_SERVICE_CATALOG_TABLE || "usa-service-catalog";
