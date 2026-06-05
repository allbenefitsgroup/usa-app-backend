import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-2";

const client = new DynamoDBClient({ region: REGION });
export const ddb = DynamoDBDocumentClient.from(client);

export const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "usa-users";
export const LEADS_TABLE = process.env.DYNAMODB_LEADS_TABLE || "usa-leads";
export const REVOKED_TOKENS_TABLE = process.env.DYNAMODB_REVOKED_TOKENS_TABLE || "usa-revoked-tokens";
export const RECOMMENDATIONS_TABLE = process.env.DYNAMODB_RECOMMENDATIONS_TABLE || "usa-recommendations";
